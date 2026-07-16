import type { StudioBridgeRequest } from '../types.js';
import { issueFixedStudioBridgeProgram, type FixedStudioBridgeProgram } from '../mcp/client.js';
import { encodeStudioBridgePayload } from './payload.js';

const PAYLOAD_MARKER = '__WORLDWRIGHT_VALIDATED_PAYLOAD__';

// All executable source is fixed here. The sole replacement is an inert,
// schema-validated JSON long-bracket literal.
const FIXED_STUDIO_BRIDGE = String.raw`
local HttpService = game:GetService("HttpService")
local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")

local PROTOCOL_VERSION = "0.1.0"
local ADAPTER_VERSION = "0.1.0"
local RESPONSE_PREFIX = "WORLDWRIGHT_STUDIO_BRIDGE_V1\n"
local MAX_NODES = 2048
local MAX_WORKSPACE_SCAN_INSTANCES = 65536
local MAX_NODE_STATE_BYTES = 262144
local MAX_INSTANCE_NAME_CODE_POINTS = 100
local MAX_RESULT_BYTES = 16777216
local MAX_STUDIO_OUTPUT_BYTES = 96 * 1024
local EPSILON = 0.00001
local payloadJson = __WORLDWRIGHT_VALIDATED_PAYLOAD__
local payload = HttpService:JSONDecode(payloadJson)

local ARRAY_MT = {}
local function array(values)
  return setmetatable(values or {}, ARRAY_MT)
end

local function canonicalJson(value)
  local valueType = typeof(value)
  if valueType == "nil" then
    return "null"
  end
  if valueType == "string" or valueType == "number" or valueType == "boolean" then
    return HttpService:JSONEncode(value)
  end
  if valueType ~= "table" then
    error("unsupported response value")
  end
  if getmetatable(value) == ARRAY_MT then
    if #value == 0 then return "[]" end
    local encoded = table.create(#value)
    for index, entry in ipairs(value) do
      encoded[index] = canonicalJson(entry)
    end
    return "[" .. table.concat(encoded, ",") .. "]"
  end
  local keys = {}
  for key in pairs(value) do
    if typeof(key) ~= "string" then
      error("response object key must be a string")
    end
    table.insert(keys, key)
  end
  table.sort(keys)
  if #keys == 0 then return "{}" end
  local encoded = table.create(#keys)
  for index, key in ipairs(keys) do
    encoded[index] = HttpService:JSONEncode(key) .. ":" .. canonicalJson(value[key])
  end
  return "{" .. table.concat(encoded, ",") .. "}"
end

local function reply(response)
  local encoded = canonicalJson(response)
  local responseBytes = #RESPONSE_PREFIX + #encoded + 1
  if responseBytes > MAX_STUDIO_OUTPUT_BYTES or responseBytes > MAX_RESULT_BYTES then
    encoded = canonicalJson({
      protocolVersion = PROTOCOL_VERSION,
      action = payload.action,
      ok = false,
      diagnostic = {
        code = "studio.response_too_large",
        message = "Studio bridge response exceeded the bounded result size.",
      },
    })
  end
  return RESPONSE_PREFIX .. encoded .. "\n"
end

local function failure(code, message, nodeId, propertyName)
  local diagnostic = { code = code, message = message }
  if nodeId ~= nil then diagnostic.nodeId = nodeId end
  if propertyName ~= nil then diagnostic.property = propertyName end
  return reply({
    protocolVersion = PROTOCOL_VERSION,
    action = payload.action,
    ok = false,
    diagnostic = diagnostic,
  })
end

local function success(fields)
  fields.protocolVersion = PROTOCOL_VERSION
  fields.action = payload.action
  fields.ok = true
  return reply(fields)
end

local function isSelectedManaged(instance, projectId)
  return instance:GetAttribute("WorldwrightManaged") == true
    and instance:GetAttribute("WorldwrightProjectId") == projectId
end

local function isAllowedMaterialName(name)
  return name == "SmoothPlastic"
    or name == "Concrete"
    or name == "Brick"
    or name == "Wood"
    or name == "WoodPlanks"
    or name == "Slate"
    or name == "Cobblestone"
    or name == "Metal"
    or name == "Glass"
    or name == "Neon"
    or name == "Grass"
    or name == "Sand"
    or name == "Rock"
    or name == "Marble"
    or name == "Granite"
end

local function isAllowedShapeName(name)
  return name == "Block" or name == "Ball" or name == "Cylinder"
end

local function materialFromName(name)
  if name == "SmoothPlastic" then return Enum.Material.SmoothPlastic end
  if name == "Concrete" then return Enum.Material.Concrete end
  if name == "Brick" then return Enum.Material.Brick end
  if name == "Wood" then return Enum.Material.Wood end
  if name == "WoodPlanks" then return Enum.Material.WoodPlanks end
  if name == "Slate" then return Enum.Material.Slate end
  if name == "Cobblestone" then return Enum.Material.Cobblestone end
  if name == "Metal" then return Enum.Material.Metal end
  if name == "Glass" then return Enum.Material.Glass end
  if name == "Neon" then return Enum.Material.Neon end
  if name == "Grass" then return Enum.Material.Grass end
  if name == "Sand" then return Enum.Material.Sand end
  if name == "Rock" then return Enum.Material.Rock end
  if name == "Marble" then return Enum.Material.Marble end
  if name == "Granite" then return Enum.Material.Granite end
  error("unsupported material")
end

local function shapeFromName(name)
  if name == "Block" then return Enum.PartType.Block end
  if name == "Ball" then return Enum.PartType.Ball end
  if name == "Cylinder" then return Enum.PartType.Cylinder end
  error("unsupported shape")
end

local function newAllowedInstance(className)
  if className == "Folder" then return Instance.new("Folder") end
  if className == "Model" then return Instance.new("Model") end
  if className == "Part" then return Instance.new("Part") end
  if className == "WedgePart" then return Instance.new("WedgePart") end
  if className == "CornerWedgePart" then return Instance.new("CornerWedgePart") end
  error("unsupported class")
end

local function isAllowedManagedClass(className)
  return className == "Folder"
    or className == "Model"
    or className == "Part"
    or className == "WedgePart"
    or className == "CornerWedgePart"
end

local function isFiniteNumber(value)
  return typeof(value) == "number"
    and value == value
    and value ~= math.huge
    and value ~= -math.huge
end

local function hasOnlyKeys(value, allowedKeys)
  if typeof(value) ~= "table" then return false end
  for key in pairs(value) do
    if typeof(key) ~= "string" or allowedKeys[key] ~= true then return false end
  end
  return true
end

local VECTOR_KEYS = { x = true, y = true, z = true }
local COLOR_KEYS = { r = true, g = true, b = true }
local NODE_KEYS = {
  id = true,
  entityKind = true,
  name = true,
  parentId = true,
  attributes = true,
  className = true,
  properties = true,
}
local ATTRIBUTE_KEYS = {
  WorldwrightManaged = true,
  WorldwrightProjectId = true,
  WorldwrightEntityId = true,
  WorldwrightEntityKind = true,
  WorldwrightCompilerVersion = true,
  WorldwrightSourceHash = true,
}
local PRIMITIVE_PROPERTY_KEYS = {
  position = true,
  rotationEulerDegreesXYZ = true,
  size = true,
  anchored = true,
  material = true,
  color = true,
  transparency = true,
  canCollide = true,
  canQuery = true,
  canTouch = true,
  castShadow = true,
}
local PART_PROPERTY_KEYS = {
  position = true,
  rotationEulerDegreesXYZ = true,
  size = true,
  anchored = true,
  material = true,
  color = true,
  transparency = true,
  canCollide = true,
  canQuery = true,
  canTouch = true,
  castShadow = true,
  shape = true,
}

local function isIdentifier(value)
  return typeof(value) == "string"
    and #value >= 1
    and #value <= 128
    and string.match(value, "^[a-z][a-z0-9-]*$") ~= nil
    and string.find(value, "--", 1, true) == nil
    and string.sub(value, -1) ~= "-"
end

local function isEntityKind(value)
  return value == "world"
    or value == "region"
    or value == "district"
    or value == "parcel"
    or value == "structure"
    or value == "floor"
    or value == "room"
    or value == "route"
    or value == "terrain"
    or value == "landmark"
    or value == "object"
    or value == "spawn"
    or value == "interaction"
end

local function isValidInstanceName(value)
  if typeof(value) ~= "string" then return false end
  local count = 0
  local valid = pcall(function()
    for _, codePoint in utf8.codes(value) do
      if codePoint > 0x10ffff or (codePoint >= 0xd800 and codePoint <= 0xdfff) then
        error("invalid Unicode scalar value")
      end
      count += 1
      if count > MAX_INSTANCE_NAME_CODE_POINTS then error("Instance.Name too long") end
    end
  end)
  return valid and count >= 1
end

local function isVectorRecord(value)
  return typeof(value) == "table"
    and hasOnlyKeys(value, VECTOR_KEYS)
    and isFiniteNumber(value.x)
    and isFiniteNumber(value.y)
    and isFiniteNumber(value.z)
end

local function isColorRecord(value)
  return typeof(value) == "table"
    and hasOnlyKeys(value, COLOR_KEYS)
    and isFiniteNumber(value.r)
    and isFiniteNumber(value.g)
    and isFiniteNumber(value.b)
    and value.r % 1 == 0
    and value.g % 1 == 0
    and value.b % 1 == 0
    and value.r >= 0
    and value.r <= 255
    and value.g >= 0
    and value.g <= 255
    and value.b >= 0
    and value.b <= 255
end

local function isLowerSha256(value)
  return typeof(value) == "string"
    and #value == 64
    and string.match(value, "^[0-9a-f]+$") ~= nil
end

local UINT32_MODULUS = 4294967296
local SHA256_INITIAL = {
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
}
local SHA256_CONSTANTS = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local HEX_DIGITS = "0123456789abcdef"

local function add32(left, right)
  return (left + right) % UINT32_MODULUS
end

local function add32x4(a, b, c, d)
  return (a + b + c + d) % UINT32_MODULUS
end

local function add32x5(a, b, c, d, e)
  return (a + b + c + d + e) % UINT32_MODULUS
end

local function uint32BigEndian(value)
  return string.char(
    bit32.band(bit32.rshift(value, 24), 0xff),
    bit32.band(bit32.rshift(value, 16), 0xff),
    bit32.band(bit32.rshift(value, 8), 0xff),
    bit32.band(value, 0xff)
  )
end

local function uint32Hex(value)
  local encoded = table.create(8)
  local outputIndex = 1
  for shift = 28, 0, -4 do
    local digit = bit32.band(bit32.rshift(value, shift), 0x0f)
    encoded[outputIndex] = string.sub(HEX_DIGITS, digit + 1, digit + 1)
    outputIndex += 1
  end
  return table.concat(encoded)
end

local function sha256Hex(message)
  local messageLength = #message
  local bitLength = messageLength * 8
  local highBitLength = math.floor(bitLength / UINT32_MODULUS)
  local lowBitLength = bitLength % UINT32_MODULUS
  local zeroByteCount = (56 - ((messageLength + 1) % 64)) % 64
  local padded = message
    .. string.char(0x80)
    .. string.rep("\0", zeroByteCount)
    .. uint32BigEndian(highBitLength)
    .. uint32BigEndian(lowBitLength)
  local hash = table.clone(SHA256_INITIAL)
  local words = table.create(64, 0)

  for chunkStart = 1, #padded, 64 do
    for wordIndex = 1, 16 do
      local byteIndex = chunkStart + (wordIndex - 1) * 4
      local b1, b2, b3, b4 = string.byte(padded, byteIndex, byteIndex + 3)
      words[wordIndex] = b1 * 0x1000000 + b2 * 0x10000 + b3 * 0x100 + b4
    end
    for wordIndex = 17, 64 do
      local previous15 = words[wordIndex - 15]
      local previous2 = words[wordIndex - 2]
      local sigma0 = bit32.bxor(
        bit32.rrotate(previous15, 7),
        bit32.rrotate(previous15, 18),
        bit32.rshift(previous15, 3)
      )
      local sigma1 = bit32.bxor(
        bit32.rrotate(previous2, 17),
        bit32.rrotate(previous2, 19),
        bit32.rshift(previous2, 10)
      )
      words[wordIndex] = add32x4(
        words[wordIndex - 16],
        sigma0,
        words[wordIndex - 7],
        sigma1
      )
    end

    local a, b, c, d = hash[1], hash[2], hash[3], hash[4]
    local e, f, g, h = hash[5], hash[6], hash[7], hash[8]
    for round = 1, 64 do
      local upperSigma1 = bit32.bxor(
        bit32.rrotate(e, 6),
        bit32.rrotate(e, 11),
        bit32.rrotate(e, 25)
      )
      local choose = bit32.bxor(bit32.band(e, f), bit32.band(bit32.bnot(e), g))
      local temporary1 = add32x5(h, upperSigma1, choose, SHA256_CONSTANTS[round], words[round])
      local upperSigma0 = bit32.bxor(
        bit32.rrotate(a, 2),
        bit32.rrotate(a, 13),
        bit32.rrotate(a, 22)
      )
      local majority = bit32.bxor(
        bit32.band(a, b),
        bit32.band(a, c),
        bit32.band(b, c)
      )
      local temporary2 = add32(upperSigma0, majority)
      h = g
      g = f
      f = e
      e = add32(d, temporary1)
      d = c
      c = b
      b = a
      a = add32(temporary1, temporary2)
    end
    hash[1] = add32(hash[1], a)
    hash[2] = add32(hash[2], b)
    hash[3] = add32(hash[3], c)
    hash[4] = add32(hash[4], d)
    hash[5] = add32(hash[5], e)
    hash[6] = add32(hash[6], f)
    hash[7] = add32(hash[7], g)
    hash[8] = add32(hash[8], h)
  end

  local encoded = table.create(8)
  for index, value in ipairs(hash) do encoded[index] = uint32Hex(value) end
  return table.concat(encoded)
end

local function sha256SelfTest()
  return sha256Hex("")
      == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    and sha256Hex("abc")
      == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    and sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
      == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
end

local function isSafeStoredNodeShape(node)
  if typeof(node) ~= "table"
    or not hasOnlyKeys(node, NODE_KEYS)
    or not isIdentifier(node.id)
    or not isEntityKind(node.entityKind)
    or not isValidInstanceName(node.name)
    or (node.parentId ~= nil and not isIdentifier(node.parentId))
    or not isAllowedManagedClass(node.className)
    or typeof(node.attributes) ~= "table"
    or typeof(node.properties) ~= "table" then
    return false
  end
  local attributes = node.attributes
  if not hasOnlyKeys(attributes, ATTRIBUTE_KEYS)
    or attributes.WorldwrightManaged ~= true
    or not isIdentifier(attributes.WorldwrightProjectId)
    or not isIdentifier(attributes.WorldwrightEntityId)
    or not isEntityKind(attributes.WorldwrightEntityKind)
    or attributes.WorldwrightCompilerVersion ~= "0.1.0"
    or (attributes.WorldwrightSourceHash ~= nil and not isLowerSha256(attributes.WorldwrightSourceHash)) then
    return false
  end
  if node.id ~= attributes.WorldwrightEntityId
    or node.entityKind ~= attributes.WorldwrightEntityKind then
    return false
  end
  if node.className == "Folder" or node.className == "Model" then
    return next(node.properties) == nil
  end
  local properties = node.properties
  if not hasOnlyKeys(
      properties,
      node.className == "Part" and PART_PROPERTY_KEYS or PRIMITIVE_PROPERTY_KEYS
    )
    or not isVectorRecord(properties.position)
    or not isVectorRecord(properties.rotationEulerDegreesXYZ)
    or not isVectorRecord(properties.size)
    or properties.size.x <= 0
    or properties.size.y <= 0
    or properties.size.z <= 0
    or not isColorRecord(properties.color)
    or properties.anchored ~= true
    or not isAllowedMaterialName(properties.material)
    or not isFiniteNumber(properties.transparency)
    or properties.transparency < 0
    or properties.transparency > 1
    or typeof(properties.canCollide) ~= "boolean"
    or typeof(properties.canQuery) ~= "boolean"
    or typeof(properties.canTouch) ~= "boolean"
    or typeof(properties.castShadow) ~= "boolean" then
    return false
  end
  if node.className == "Part" and not isAllowedShapeName(properties.shape) then return false end
  return true
end

local function expectedCFrame(node)
  local properties = node.properties
  local position = properties.position
  local rotation = properties.rotationEulerDegreesXYZ
  return CFrame.new(position.x, position.y, position.z)
    * CFrame.fromEulerAnglesXYZ(
      math.rad(rotation.x),
      math.rad(rotation.y),
      math.rad(rotation.z)
    )
end

local function nearlyEqual(left, right)
  return math.abs(left - right) <= EPSILON
end

local function cframesEqual(left, right)
  local leftComponents = { left:GetComponents() }
  local rightComponents = { right:GetComponents() }
  for index = 1, 12 do
    if not nearlyEqual(leftComponents[index], rightComponents[index]) then return false end
  end
  return true
end

local function parentMatches(instance, node, index)
  if node.parentId == nil then return instance.Parent == Workspace end
  return instance.Parent == index[node.parentId]
end

local function verifyAttributes(instance, node, stateJson, stateHash)
  local attributes = node.attributes
  if instance:GetAttribute("WorldwrightManaged") ~= true then return false, "WorldwrightManaged" end
  if instance:GetAttribute("WorldwrightProjectId") ~= attributes.WorldwrightProjectId then return false, "WorldwrightProjectId" end
  if instance:GetAttribute("WorldwrightEntityId") ~= attributes.WorldwrightEntityId then return false, "WorldwrightEntityId" end
  if instance:GetAttribute("WorldwrightEntityKind") ~= attributes.WorldwrightEntityKind then return false, "WorldwrightEntityKind" end
  if instance:GetAttribute("WorldwrightCompilerVersion") ~= attributes.WorldwrightCompilerVersion then return false, "WorldwrightCompilerVersion" end
  if instance:GetAttribute("WorldwrightSourceHash") ~= attributes.WorldwrightSourceHash then return false, "WorldwrightSourceHash" end
  if instance:GetAttribute("WorldwrightStudioAdapterVersion") ~= ADAPTER_VERSION then return false, "WorldwrightStudioAdapterVersion" end
  if instance:GetAttribute("WorldwrightStudioStateJson") ~= stateJson then return false, "WorldwrightStudioStateJson" end
  if instance:GetAttribute("WorldwrightStudioStateHash") ~= stateHash then return false, "WorldwrightStudioStateHash" end
  for attributeName in pairs(instance:GetAttributes()) do
    if string.sub(attributeName, 1, 17) == "WorldwrightStudio" then
      if attributeName ~= "WorldwrightStudioAdapterVersion"
        and attributeName ~= "WorldwrightStudioStateJson"
        and attributeName ~= "WorldwrightStudioStateHash" then
        return false, attributeName
      end
    end
  end
  return true, nil
end

local function verifyProperties(instance, node)
  if node.className == "Folder" or node.className == "Model" then return true, nil end
  local properties = node.properties
  if not cframesEqual(instance.CFrame, expectedCFrame(node)) then return false, "CFrame" end
  if not nearlyEqual(instance.Size.X, properties.size.x)
    or not nearlyEqual(instance.Size.Y, properties.size.y)
    or not nearlyEqual(instance.Size.Z, properties.size.z) then return false, "Size" end
  if instance.Anchored ~= properties.anchored then return false, "Anchored" end
  if instance.Material ~= materialFromName(properties.material) then return false, "Material" end
  if not nearlyEqual(instance.Color.R, properties.color.r / 255)
    or not nearlyEqual(instance.Color.G, properties.color.g / 255)
    or not nearlyEqual(instance.Color.B, properties.color.b / 255) then return false, "Color" end
  if not nearlyEqual(instance.Transparency, properties.transparency) then return false, "Transparency" end
  if instance.CanCollide ~= properties.canCollide then return false, "CanCollide" end
  if instance.CanQuery ~= properties.canQuery then return false, "CanQuery" end
  if instance.CanTouch ~= properties.canTouch then return false, "CanTouch" end
  if instance.CastShadow ~= properties.castShadow then return false, "CastShadow" end
  if node.className == "Part" and instance.Shape ~= shapeFromName(properties.shape) then return false, "Shape" end
  return true, nil
end

local function verifyInstance(instance, node, stateJson, stateHash, index)
  if instance.ClassName ~= node.className then return false, "ClassName" end
  if instance.Name ~= node.name then return false, "Name" end
  if not parentMatches(instance, node, index) then return false, "Parent" end
  local attributesOk, attributeName = verifyAttributes(instance, node, stateJson, stateHash)
  if not attributesOk then return false, attributeName end
  return verifyProperties(instance, node)
end

local function readStoredNode(instance, projectId)
  local adapterVersion = instance:GetAttribute("WorldwrightStudioAdapterVersion")
  local stateJson = instance:GetAttribute("WorldwrightStudioStateJson")
  local stateHash = instance:GetAttribute("WorldwrightStudioStateHash")
  if adapterVersion ~= ADAPTER_VERSION
    or typeof(stateJson) ~= "string"
    or stateJson == ""
    or not isLowerSha256(stateHash) then
    return nil, nil, nil, "studio.adapter_metadata_invalid"
  end
  if #stateJson > MAX_NODE_STATE_BYTES then
    return nil, nil, nil, "studio.adapter_metadata_too_large"
  end
  local hashed, computedStateHash = pcall(function() return sha256Hex(stateJson) end)
  if not hashed or computedStateHash ~= stateHash then
    return nil, nil, nil, "studio.adapter_metadata_invalid"
  end
  for attributeName in pairs(instance:GetAttributes()) do
    if string.sub(attributeName, 1, 17) == "WorldwrightStudio"
      and attributeName ~= "WorldwrightStudioAdapterVersion"
      and attributeName ~= "WorldwrightStudioStateJson"
      and attributeName ~= "WorldwrightStudioStateHash" then
      return nil, nil, nil, "studio.adapter_metadata_invalid"
    end
  end
  local decoded, node = pcall(function() return HttpService:JSONDecode(stateJson) end)
  if not decoded or not isSafeStoredNodeShape(node) then
    return nil, nil, nil, "studio.adapter_metadata_invalid"
  end
  local entityId = instance:GetAttribute("WorldwrightEntityId")
  if node.id ~= entityId
    or node.attributes.WorldwrightEntityId ~= entityId
    or node.attributes.WorldwrightProjectId ~= projectId then
    return nil, nil, nil, "studio.adapter_metadata_invalid"
  end
  return node, stateJson, stateHash, nil
end

local function verifyStoredManagedInstance(instance, projectId, index)
  local node, stateJson, stateHash, metadataError = readStoredNode(instance, projectId)
  if metadataError ~= nil then return false, metadataError, nil, nil, nil end
  local verified, valid, propertyName = pcall(function()
    return verifyInstance(instance, node, stateJson, stateHash, index)
  end)
  if not verified then return false, "studio.adapter_metadata_invalid", nil, nil, nil end
  if not valid then return false, "studio.engine_state_drift", propertyName, nil, nil end
  return true, nil, nil, node, stateHash
end

local function setPublicNodeState(instance, node)
  instance.Name = node.name
  if node.className ~= "Folder" and node.className ~= "Model" then
    local properties = node.properties
    instance.CFrame = expectedCFrame(node)
    instance.Size = Vector3.new(properties.size.x, properties.size.y, properties.size.z)
    instance.Anchored = properties.anchored
    instance.Material = materialFromName(properties.material)
    instance.Color = Color3.fromRGB(properties.color.r, properties.color.g, properties.color.b)
    instance.Transparency = properties.transparency
    instance.CanCollide = properties.canCollide
    instance.CanQuery = properties.canQuery
    instance.CanTouch = properties.canTouch
    instance.CastShadow = properties.castShadow
    if node.className == "Part" then instance.Shape = shapeFromName(properties.shape) end
  end
  local attributes = node.attributes
  instance:SetAttribute("WorldwrightManaged", true)
  instance:SetAttribute("WorldwrightProjectId", attributes.WorldwrightProjectId)
  instance:SetAttribute("WorldwrightEntityId", attributes.WorldwrightEntityId)
  instance:SetAttribute("WorldwrightEntityKind", attributes.WorldwrightEntityKind)
  instance:SetAttribute("WorldwrightCompilerVersion", attributes.WorldwrightCompilerVersion)
  instance:SetAttribute("WorldwrightSourceHash", attributes.WorldwrightSourceHash)
end

local function setAdapterMetadata(instance, stateJson, stateHash)
  instance:SetAttribute("WorldwrightStudioAdapterVersion", ADAPTER_VERSION)
  instance:SetAttribute("WorldwrightStudioStateJson", stateJson)
  instance:SetAttribute("WorldwrightStudioStateHash", stateHash)
end

local function setCreatedNodeState(instance, node, stateJson, stateHash, parent)
  setPublicNodeState(instance, node)
  setAdapterMetadata(instance, stateJson, stateHash)
  instance.Parent = parent
end

local function setUpdatedNodeState(instance, node, stateJson, stateHash, parent)
  setPublicNodeState(instance, node)
  instance.Parent = parent
  setAdapterMetadata(instance, stateJson, stateHash)
end

local function buildProjectIndex(projectId)
  local index = {}
  local workspaceChildren = Workspace:GetChildren()
  if #workspaceChildren > MAX_WORKSPACE_SCAN_INSTANCES then
    return nil, nil, "studio.node_limit_exceeded", 0
  end
  local root = nil
  for _, instance in ipairs(workspaceChildren) do
    if isSelectedManaged(instance, projectId) then
      if root ~= nil then return nil, nil, "studio.root_invalid", 0 end
      root = instance
    end
  end
  if root == nil then return nil, index, nil, 0 end
  if root.ClassName ~= "Folder" and root.ClassName ~= "Model" then
    return nil, nil, "studio.root_invalid", 0
  end

  local pending = {root}
  local cursor = 1
  local selectedCount = 0
  local scannedCount = #workspaceChildren
  while cursor <= #pending do
    local instance = pending[cursor]
    cursor += 1
    selectedCount += 1
    if selectedCount > MAX_NODES then
      return nil, nil, "studio.node_limit_exceeded", selectedCount
    end
    if not isAllowedManagedClass(instance.ClassName) then
      return nil, nil, "studio.class_unsupported", selectedCount
    end
    local entityId = instance:GetAttribute("WorldwrightEntityId")
    if not isIdentifier(entityId) then
      return nil, nil, "studio.identity_invalid", selectedCount
    end
    if index[entityId] ~= nil then
      return nil, nil, "studio.identity_invalid", selectedCount
    end
    index[entityId] = instance

    local children = instance:GetChildren()
    scannedCount += #children
    if scannedCount > MAX_WORKSPACE_SCAN_INSTANCES then
      return nil, nil, "studio.node_limit_exceeded", selectedCount
    end
    for _, child in ipairs(children) do
      if isSelectedManaged(child, projectId) then
        if instance.ClassName ~= "Folder" and instance.ClassName ~= "Model" then
          return nil, nil, "studio.hierarchy_invalid", selectedCount
        end
        table.insert(pending, child)
      end
    end
  end
  return root, index, nil, selectedCount
end

local function resolveParent(node, root, index, existingRoot)
  if node.parentId == nil then
    if root ~= nil and root ~= existingRoot then return nil, "studio.root_invalid" end
    return Workspace, nil
  end
  local parent = index[node.parentId]
  if parent == nil then return nil, "studio.hierarchy_invalid" end
  if parent.ClassName ~= "Folder" and parent.ClassName ~= "Model" then return nil, "studio.hierarchy_invalid" end
  return parent, nil
end

local function verifyResolvedParent(parent, node, projectId, index, expectedParentState)
  if parent == Workspace then
    if expectedParentState ~= nil then return false, "studio.hierarchy_invalid", "Parent" end
    return true, nil, nil
  end
  if expectedParentState == nil then
    return false, "studio.hierarchy_invalid", "Parent"
  end
  local expectedParent = expectedParentState.node
  if not isSafeStoredNodeShape(expectedParent)
    or expectedParent.id ~= node.parentId
    or expectedParent.attributes.WorldwrightEntityId ~= node.parentId
    or expectedParent.attributes.WorldwrightProjectId ~= projectId
    or index[expectedParent.id] ~= parent
    or typeof(expectedParentState.stateJson) ~= "string"
    or expectedParentState.stateJson == ""
    or #expectedParentState.stateJson > MAX_NODE_STATE_BYTES
    or not isLowerSha256(expectedParentState.stateHash) then
    return false, "studio.adapter_metadata_invalid", "Parent"
  end
  local verified, valid, propertyName = pcall(function()
    return verifyInstance(
      parent,
      expectedParent,
      expectedParentState.stateJson,
      expectedParentState.stateHash,
      index
    )
  end)
  if not verified then return false, "studio.adapter_metadata_invalid", "Parent" end
  if not valid then return false, "studio.engine_state_drift", propertyName end
  return true, nil, nil
end

local function hasProtectedDescendant(instance, projectId)
  local pending = { instance }
  local cursor = 1
  local visited = 0
  while cursor <= #pending do
    local current = pending[cursor]
    cursor += 1
    for _, child in ipairs(current:GetChildren()) do
      if not isSelectedManaged(child, projectId) then return true end
      visited += 1
      if visited > MAX_NODES then return true end
      table.insert(pending, child)
    end
  end
  return false
end

local function hasManagedChild(instance, projectId)
  for _, child in ipairs(instance:GetChildren()) do
    if isSelectedManaged(child, projectId) then return true end
  end
  return false
end

local function cleanupFailedCreate(instance, node, projectId)
  if instance == nil then return true end
  local parentObserved, parent = pcall(function() return instance.Parent end)
  if not parentObserved then return false end
  local wasParented = parent ~= nil
  if #instance:GetChildren() ~= 0 then return false end
  if wasParented then
    if not isSelectedManaged(instance, projectId)
      or instance:GetAttribute("WorldwrightEntityId") ~= node.id
      or instance.ClassName ~= node.className then
      return false
    end
    if hasProtectedDescendant(instance, projectId) then return false end
  end
  local destroyed = pcall(function() instance:Destroy() end)
  local finalParentObserved, finalParent = pcall(function() return instance.Parent end)
  if not destroyed or not finalParentObserved or finalParent ~= nil then return false end
  if wasParented then
    local _, finalIndex, finalError = buildProjectIndex(projectId)
    if finalError ~= nil or finalIndex[node.id] ~= nil then return false end
  end
  return true
end

local function normalizedNumber(value)
  if value == 0 then return 0 end
  return value
end

local function addDictionaryValue(values, seen, value)
  if seen[value] == nil then
    seen[value] = true
    table.insert(values, value)
  end
end

local function sortAndIndexDictionary(values)
  table.sort(values)
  local index = {}
  for valueIndex, value in ipairs(values) do index[value] = valueIndex - 1 end
  return index
end

local function utf8CodePointsAndOffsets(value)
  if not isValidInstanceName(value) then return nil, nil end
  local codePoints = array()
  local byteOffsets = array()
  local valid = pcall(function()
    for byteIndex, codePoint in utf8.codes(value) do
      table.insert(byteOffsets, byteIndex)
      table.insert(codePoints, codePoint)
    end
  end)
  if not valid then return nil, nil end
  return codePoints, byteOffsets
end

local function frontCodeSortedNames(values)
  local encoded = array()
  local previousCodePoints = nil
  for _, value in ipairs(values) do
    local codePoints, byteOffsets = utf8CodePointsAndOffsets(value)
    if codePoints == nil then return nil end
    local commonPrefixCodePointCount = 0
    if previousCodePoints ~= nil then
      local maximumPrefix = math.min(#previousCodePoints, #codePoints)
      while commonPrefixCodePointCount < maximumPrefix
        and previousCodePoints[commonPrefixCodePointCount + 1]
          == codePoints[commonPrefixCodePointCount + 1] do
        commonPrefixCodePointCount += 1
      end
    end
    local suffixByteOffset = byteOffsets[commonPrefixCodePointCount + 1]
    if suffixByteOffset == nil then return nil end
    local suffix = string.sub(value, suffixByteOffset)
    if suffix == "" then return nil end
    table.insert(encoded, array({ commonPrefixCodePointCount, suffix }))
    previousCodePoints = codePoints
  end
  return encoded
end

local Z85_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#"

local function z85EncodeSha256(stateHash)
  if not isLowerSha256(stateHash) then return nil end
  local encoded = table.create(40)
  local outputIndex = 1
  for hexIndex = 1, 64, 8 do
    local value = tonumber(string.sub(stateHash, hexIndex, hexIndex + 7), 16)
    if value == nil then return nil end
    local block = table.create(5)
    for digitIndex = 5, 1, -1 do
      local digit = value % 85
      value = math.floor(value / 85)
      block[digitIndex] = string.sub(Z85_ALPHABET, digit + 1, digit + 1)
    end
    for digitIndex = 1, 5 do
      encoded[outputIndex] = block[digitIndex]
      outputIndex += 1
    end
  end
  local result = table.concat(encoded)
  if #result ~= 40 then return nil end
  return result
end

local function splitEntityId(entityId)
  local tokens = array()
  for token in string.gmatch(entityId, "[^-]+") do table.insert(tokens, token) end
  return tokens
end

local function classCode(className)
  if className == "Folder" then return 0 end
  if className == "Model" then return 1 end
  if className == "Part" then return 2 end
  if className == "WedgePart" then return 3 end
  if className == "CornerWedgePart" then return 4 end
  return nil
end

local function snapshotAction()
  local selfTested, selfTestPassed = pcall(sha256SelfTest)
  if not selfTested or not selfTestPassed then
    return failure(
      "studio.adapter_metadata_invalid",
      "Studio metadata integrity self-test failed."
    )
  end
  local projectId = payload.projectId
  local selectedInstances = {}
  local selectedChildren = {}
  local projectIndex = {}
  local selectedCount = 0
  local cumulativeMetadataBytes = 0
  local pending = Workspace:GetChildren()
  if #pending > MAX_WORKSPACE_SCAN_INSTANCES then
    return failure("studio.node_limit_exceeded", "Workspace structural scan limit exceeded.")
  end
  local cursor = 1
  while cursor <= #pending do
    local instance = pending[cursor]
    cursor += 1
    if isSelectedManaged(instance, projectId) then
      selectedCount += 1
      if selectedCount > MAX_NODES then return failure("studio.node_limit_exceeded", "Managed node limit exceeded.") end
      local entityId = instance:GetAttribute("WorldwrightEntityId")
      if not isIdentifier(entityId) then
        return failure("studio.identity_invalid", "Managed entity ID is missing or invalid.")
      end
      if not isAllowedManagedClass(instance.ClassName) then
        return failure("studio.class_unsupported", "Managed instance class is unsupported.", entityId)
      end
      if projectIndex[entityId] ~= nil then
        return failure("studio.identity_invalid", "Managed entity ID is duplicated.", entityId)
      end
      projectIndex[entityId] = instance
      table.insert(selectedInstances, instance)
    end
    local children = instance:GetChildren()
    if isSelectedManaged(instance, projectId) then selectedChildren[instance] = children end
    if #pending + #children > MAX_WORKSPACE_SCAN_INSTANCES then
      return failure("studio.node_limit_exceeded", "Workspace structural scan limit exceeded.")
    end
    for _, child in ipairs(children) do table.insert(pending, child) end
  end

  if selectedCount > 0 then
    local root = nil
    for _, instance in ipairs(selectedInstances) do
      if instance.Parent == Workspace then
        if root ~= nil then return failure("studio.root_invalid", "Managed project has multiple roots.") end
        root = instance
      end
    end
    if root == nil or (root.ClassName ~= "Folder" and root.ClassName ~= "Model") then
      return failure("studio.root_invalid", "Managed project root is invalid.")
    end
  end

  local selectedNodes = {}
  local selectedStateHashes = {}
  for _, instance in ipairs(selectedInstances) do
    local entityId = instance:GetAttribute("WorldwrightEntityId")
    local parent = instance.Parent
    if parent ~= Workspace
      and parent ~= nil
      and isSelectedManaged(parent, projectId)
      and parent.ClassName ~= "Folder"
      and parent.ClassName ~= "Model" then
      return failure("studio.hierarchy_invalid", "Managed parent class is invalid.", entityId)
    end
    local valid, validationCode, propertyName, node, stateHash = verifyStoredManagedInstance(
      instance,
      projectId,
      projectIndex
    )
    if not valid then
      return failure(validationCode, "Managed instance state is invalid.", entityId, propertyName)
    end
    local stateJson = instance:GetAttribute("WorldwrightStudioStateJson")
    cumulativeMetadataBytes += #stateJson + #node.id + #node.name + 1024
    if cumulativeMetadataBytes > MAX_RESULT_BYTES then
      return failure("studio.response_too_large", "Snapshot metadata exceeds the cumulative work budget.")
    end
    selectedNodes[instance] = node
    selectedStateHashes[instance] = stateHash
  end
  table.sort(selectedInstances, function(left, right)
    return selectedNodes[left].id < selectedNodes[right].id
  end)

  local encodedStateHashes = table.create(#selectedInstances)
  for index, instance in ipairs(selectedInstances) do
    local encodedStateHash = z85EncodeSha256(selectedStateHashes[instance])
    if encodedStateHash == nil then
      return failure(
        "studio.adapter_metadata_invalid",
        "Managed state hash could not be encoded safely.",
        selectedNodes[instance].id
      )
    end
    encodedStateHashes[index] = encodedStateHash
  end
  local stateHashesZ85 = table.concat(encodedStateHashes)
  if #stateHashesZ85 ~= #selectedInstances * 40 then
    return failure("studio.adapter_metadata_invalid", "Managed state hashes could not be packed exactly.")
  end

  local idTokens = array()
  local names = array()
  local entityKinds = array()
  local sourceHashes = array()
  local numbers = array()
  local materials = array()
  local shapes = array()
  local unmanagedClasses = array()
  local idTokensSeen = {}
  local namesSeen = {}
  local entityKindsSeen = {}
  local sourceHashesSeen = {}
  local numbersSeen = {}
  local materialsSeen = {}
  local shapesSeen = {}
  local unmanagedClassesSeen = {}
  local nodeTokenSequences = {}
  local nodeIndexById = {}

  for nodePosition, instance in ipairs(selectedInstances) do
    local node = selectedNodes[instance]
    nodeIndexById[node.id] = nodePosition - 1
    local tokens = splitEntityId(node.id)
    if #tokens == 0 or table.concat(tokens, "-") ~= node.id then
      return failure("studio.identity_invalid", "Managed entity ID could not be tokenized exactly.", node.id)
    end
    nodeTokenSequences[node.id] = tokens
    for _, token in ipairs(tokens) do addDictionaryValue(idTokens, idTokensSeen, token) end
    addDictionaryValue(names, namesSeen, node.name)
    addDictionaryValue(entityKinds, entityKindsSeen, node.entityKind)
    local sourceHash = node.attributes.WorldwrightSourceHash
    if sourceHash ~= nil then
      addDictionaryValue(sourceHashes, sourceHashesSeen, sourceHash)
    end
    if node.className ~= "Folder" and node.className ~= "Model" then
      local properties = node.properties
      local primitiveNumbers = {
        properties.position.x,
        properties.position.y,
        properties.position.z,
        properties.rotationEulerDegreesXYZ.x,
        properties.rotationEulerDegreesXYZ.y,
        properties.rotationEulerDegreesXYZ.z,
        properties.size.x,
        properties.size.y,
        properties.size.z,
        properties.color.r,
        properties.color.g,
        properties.color.b,
        properties.transparency,
      }
      for _, value in ipairs(primitiveNumbers) do
        addDictionaryValue(numbers, numbersSeen, normalizedNumber(value))
      end
      addDictionaryValue(materials, materialsSeen, properties.material)
      if node.className == "Part" then
        addDictionaryValue(shapes, shapesSeen, properties.shape)
      end
    end
  end

  local unmanagedRecords = {}
  for _, instance in ipairs(selectedInstances) do
    local parentId = selectedNodes[instance].id
    if typeof(parentId) ~= "string" or parentId == "" then
      return failure("studio.identity_invalid", "Managed parent ID is missing or invalid.")
    end
    local unmanagedChildren = {}
    for _, child in ipairs(selectedChildren[instance]) do
      if not isSelectedManaged(child, projectId) then
        if child.Name == "" then
          return failure("studio.snapshot_invalid", "Unmanaged root has an empty display name.", parentId)
        end
        table.insert(unmanagedChildren, {
          className = child.ClassName,
          name = child.Name,
        })
      end
    end
    table.sort(unmanagedChildren, function(left, right)
      if left.className ~= right.className then return left.className < right.className end
      if left.name ~= right.name then return left.name < right.name end
      return false
    end)
    local duplicateCounts = {}
    for _, child in ipairs(unmanagedChildren) do
      if #unmanagedRecords >= MAX_NODES then
        return failure("studio.node_limit_exceeded", "Unmanaged-root marker limit exceeded.")
      end
      if #parentId + #child.className + #child.name + 16 > 2048 then
        return failure("studio.snapshot_invalid", "Unmanaged structural path is too long.", parentId)
      end
      local duplicateKey = child.className .. "\0" .. child.name
      local duplicateOrdinal = (duplicateCounts[duplicateKey] or 0) + 1
      duplicateCounts[duplicateKey] = duplicateOrdinal
      local structuralPath = parentId
        .. "/"
        .. child.className
        .. "/"
        .. child.name
        .. "/"
        .. tostring(duplicateOrdinal)
      if #structuralPath > 2048 then
        return failure("studio.snapshot_invalid", "Unmanaged structural path is too long.", parentId)
      end
      addDictionaryValue(names, namesSeen, child.name)
      addDictionaryValue(unmanagedClasses, unmanagedClassesSeen, child.className)
      table.insert(unmanagedRecords, {
        parentId = parentId,
        className = child.className,
        name = child.name,
        ordinal = duplicateOrdinal,
      })
    end
  end
  table.sort(unmanagedRecords, function(left, right)
    if left.parentId ~= right.parentId then return left.parentId < right.parentId end
    if left.className ~= right.className then return left.className < right.className end
    if left.name ~= right.name then return left.name < right.name end
    return left.ordinal < right.ordinal
  end)

  local idTokenIndex = sortAndIndexDictionary(idTokens)
  local nameIndex = sortAndIndexDictionary(names)
  local frontCodedNames = frontCodeSortedNames(names)
  if frontCodedNames == nil then
    return failure("studio.snapshot_invalid", "Snapshot names could not be encoded as valid Unicode.")
  end
  local entityKindIndex = sortAndIndexDictionary(entityKinds)
  local sourceHashIndex = sortAndIndexDictionary(sourceHashes)
  local numberIndex = sortAndIndexDictionary(numbers)
  local materialIndex = sortAndIndexDictionary(materials)
  local shapeIndex = sortAndIndexDictionary(shapes)
  local unmanagedClassIndex = sortAndIndexDictionary(unmanagedClasses)

  local compactNodes = array()
  for _, instance in ipairs(selectedInstances) do
    local node = selectedNodes[instance]
    local tokenIndices = array()
    for _, token in ipairs(nodeTokenSequences[node.id]) do
      table.insert(tokenIndices, idTokenIndex[token])
    end
    local parentIndex = -1
    if node.parentId ~= nil then
      parentIndex = nodeIndexById[node.parentId]
      if parentIndex == nil then
        return failure("studio.hierarchy_invalid", "Managed parent index is invalid.", node.id)
      end
    end
    local encodedSourceHashIndex = -1
    local sourceHash = node.attributes.WorldwrightSourceHash
    if sourceHash ~= nil then encodedSourceHashIndex = sourceHashIndex[sourceHash] end
    local tuple = array({
      tokenIndices,
      parentIndex,
      classCode(node.className),
      nameIndex[node.name],
      entityKindIndex[node.entityKind],
      encodedSourceHashIndex,
    })
    if node.className ~= "Folder" and node.className ~= "Model" then
      local properties = node.properties
      table.insert(tuple, numberIndex[normalizedNumber(properties.position.x)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.position.y)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.position.z)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.rotationEulerDegreesXYZ.x)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.rotationEulerDegreesXYZ.y)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.rotationEulerDegreesXYZ.z)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.size.x)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.size.y)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.size.z)])
      table.insert(tuple, materialIndex[properties.material])
      table.insert(tuple, numberIndex[normalizedNumber(properties.color.r)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.color.g)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.color.b)])
      table.insert(tuple, numberIndex[normalizedNumber(properties.transparency)])
      local flags = 0
      if properties.anchored then flags += 1 end
      if properties.canCollide then flags += 2 end
      if properties.canQuery then flags += 4 end
      if properties.canTouch then flags += 8 end
      if properties.castShadow then flags += 16 end
      table.insert(tuple, flags)
      table.insert(tuple, node.className == "Part" and shapeIndex[properties.shape] or -1)
    end
    table.insert(compactNodes, tuple)
  end

  local compactUnmanagedRoots = array()
  for _, unmanaged in ipairs(unmanagedRecords) do
    table.insert(compactUnmanagedRoots, array({
      nodeIndexById[unmanaged.parentId],
      unmanagedClassIndex[unmanaged.className],
      nameIndex[unmanaged.name],
      unmanaged.ordinal,
    }))
  end

  return success({
    compactSnapshot = {
      projectId = projectId,
      idTokens = idTokens,
      names = frontCodedNames,
      stateHashesZ85 = stateHashesZ85,
      entityKinds = entityKinds,
      sourceHashes = sourceHashes,
      numbers = numbers,
      materials = materials,
      shapes = shapes,
      nodes = compactNodes,
      unmanagedClasses = unmanagedClasses,
      unmanagedRoots = compactUnmanagedRoots,
    },
  })
end

local function probeAction()
  return success({
    probe = {
      placeName = game.Name,
      placeId = game.PlaceId,
      gameId = game.GameId,
      isRunning = RunService:IsRunning(),
      isEditAvailable = true,
    },
  })
end

local function sandboxGate()
  if game.PlaceId ~= 0 or game.GameId ~= 0 then
    return failure(
      "studio.published_place_forbidden",
      "Worldwright may access managed project state only in an unsaved local sandbox."
    )
  end
  if RunService:IsRunning() then
    return failure(
      "studio.edit_mode_required",
      "Worldwright requires the stopped Edit data model."
    )
  end
  return nil
end

local function createAction()
  local node = payload.node
  if not isValidInstanceName(node.name) then
    return failure("studio.property_invalid", "Managed Instance.Name is invalid or too long.", node.id, "Name")
  end
  local root, index, indexError = buildProjectIndex(payload.projectId)
  if indexError ~= nil then return failure(indexError, "Managed project index is invalid.", node.id) end
  if index[node.id] ~= nil then return failure("studio.create_failed", "Managed entity already exists.", node.id) end
  local parent, parentError = resolveParent(node, root, index)
  if parentError ~= nil then return failure(parentError, "Create parent is invalid.", node.id) end
  local parentValid, parentValidationCode, parentProperty = verifyResolvedParent(
    parent,
    node,
    payload.projectId,
    index,
    payload.parentState
  )
  if not parentValid then
    return failure(parentValidationCode, "Create parent state is invalid.", node.parentId, parentProperty)
  end
  local instance = nil
  local ok = pcall(function()
    instance = newAllowedInstance(node.className)
    setCreatedNodeState(instance, node, payload.stateJson, payload.stateHash, parent)
    local updatedRoot, updatedIndex, updatedError = buildProjectIndex(payload.projectId)
    if updatedError ~= nil then error(updatedError) end
    local created = updatedIndex[node.id]
    if created ~= instance then error("created instance was not indexed") end
    local valid = verifyInstance(created, node, payload.stateJson, payload.stateHash, updatedIndex)
    if not valid then error("created instance verification failed") end
    if node.parentId == nil and updatedRoot ~= instance then error("created root mismatch") end
  end)
  if not ok then
    local cleanupObserved, cleanupComplete = pcall(function()
      return cleanupFailedCreate(instance, node, payload.projectId)
    end)
    if cleanupObserved and cleanupComplete then
      return failure("studio.create_failed", "Create failed and exact cleanup was verified.", node.id)
    end
    return failure(
      "studio.create_cleanup_failed",
      "Create failed and cleanup could not be proven safe and complete.",
      node.id
    )
  end
  return success({ nodeId = node.id })
end

local function updateAction()
  local before = payload.before
  local after = payload.after
  if not isValidInstanceName(before.name) then
    return failure("studio.property_invalid", "Managed before Instance.Name is invalid or too long.", before.id, "Name")
  end
  if not isValidInstanceName(after.name) then
    return failure("studio.property_invalid", "Managed after Instance.Name is invalid or too long.", after.id, "Name")
  end
  local root, index, indexError = buildProjectIndex(payload.projectId)
  if indexError ~= nil then return failure(indexError, "Managed project index is invalid.", before.id) end
  local instance = index[before.id]
  if instance == nil then return failure("studio.update_failed", "Update target is absent.", before.id) end
  local beforeValid, beforeProperty = verifyInstance(instance, before, payload.beforeStateJson, payload.beforeStateHash, index)
  if not beforeValid then return failure("studio.engine_state_drift", "Update target differs from its complete before state.", before.id, beforeProperty) end
  if before.id ~= after.id or before.className ~= after.className then
    return failure("studio.update_failed", "Update identity or class changed.", before.id)
  end
  local beforeParent, beforeParentError = resolveParent(before, root, index, instance)
  if beforeParentError ~= nil then return failure(beforeParentError, "Update source parent is invalid.", before.id) end
  local beforeParentValid, beforeParentValidationCode, beforeParentProperty = verifyResolvedParent(
    beforeParent,
    before,
    payload.projectId,
    index,
    payload.beforeParentState
  )
  if not beforeParentValid then
    return failure(
      beforeParentValidationCode,
      "Update source parent state is invalid.",
      before.parentId,
      beforeParentProperty
    )
  end
  if before.parentId ~= after.parentId and hasProtectedDescendant(instance, payload.projectId) then
    return failure("studio.unmanaged_content_protected", "Reparent is blocked by unmanaged or foreign descendants.", before.id)
  end
  local parent, parentError = resolveParent(after, root, index, instance)
  if parentError ~= nil then return failure(parentError, "Update parent is invalid.", before.id) end
  if parent == instance or (parent ~= Workspace and parent:IsDescendantOf(instance)) then
    return failure("studio.hierarchy_invalid", "Update parent would create a cycle.", before.id)
  end
  local parentValid, parentValidationCode, parentProperty = verifyResolvedParent(
    parent,
    after,
    payload.projectId,
    index,
    payload.afterParentState
  )
  if not parentValid then
    return failure(parentValidationCode, "Update parent state is invalid.", after.parentId, parentProperty)
  end
  local applied = pcall(function()
    setUpdatedNodeState(instance, after, payload.afterStateJson, payload.afterStateHash, parent)
    local _, updatedIndex, updatedError = buildProjectIndex(payload.projectId)
    if updatedError ~= nil then error(updatedError) end
    local valid = verifyInstance(instance, after, payload.afterStateJson, payload.afterStateHash, updatedIndex)
    if not valid then error("updated instance verification failed") end
  end)
  if not applied then
    local restored = pcall(function()
      local restoredRoot, restoredIndex, restoredError = buildProjectIndex(payload.projectId)
      if restoredError ~= nil then error(restoredError) end
      local restoredParent, restoredParentError = resolveParent(before, restoredRoot, restoredIndex, instance)
      if restoredParentError ~= nil then error(restoredParentError) end
      local restoredParentValid = verifyResolvedParent(
        restoredParent,
        before,
        payload.projectId,
        restoredIndex,
        payload.beforeParentState
      )
      if not restoredParentValid then error("restore parent state invalid") end
      setUpdatedNodeState(instance, before, payload.beforeStateJson, payload.beforeStateHash, restoredParent)
      local _, finalIndex, finalError = buildProjectIndex(payload.projectId)
      if finalError ~= nil then error(finalError) end
      local valid = verifyInstance(instance, before, payload.beforeStateJson, payload.beforeStateHash, finalIndex)
      if not valid then error("restored instance verification failed") end
    end)
    if not restored then return failure("studio.update_restore_failed", "Update failed and exact local restoration could not be verified.", before.id) end
    return failure("studio.update_failed", "Update failed; the complete before state was restored.", before.id)
  end
  return success({ nodeId = before.id })
end

local function deleteAction()
  local before = payload.before
  if not isValidInstanceName(before.name) then
    return failure("studio.property_invalid", "Managed Instance.Name is invalid or too long.", before.id, "Name")
  end
  local _, index, indexError = buildProjectIndex(payload.projectId)
  if indexError ~= nil then return failure(indexError, "Managed project index is invalid.", before.id) end
  local instance = index[before.id]
  if instance == nil then return failure("studio.delete_failed", "Delete target is absent.", before.id) end
  local beforeValid, beforeProperty = verifyInstance(instance, before, payload.beforeStateJson, payload.beforeStateHash, index)
  if not beforeValid then return failure("studio.engine_state_drift", "Delete target differs from its complete before state.", before.id, beforeProperty) end
  if hasManagedChild(instance, payload.projectId) then
    return failure("studio.delete_failed", "Delete target still contains managed descendants.", before.id)
  end
  if hasProtectedDescendant(instance, payload.projectId) then
    return failure("studio.unmanaged_content_protected", "Delete is blocked by unmanaged or foreign descendants.", before.id)
  end
  local deleted = pcall(function() instance:Destroy() end)
  if not deleted then return failure("studio.delete_failed", "Delete failed.", before.id) end
  local _, finalIndex, finalError = buildProjectIndex(payload.projectId)
  if finalError ~= nil or finalIndex[before.id] ~= nil then
    return failure("studio.delete_failed", "Delete absence could not be verified.", before.id)
  end
  return success({ nodeId = before.id })
end

if payload.protocolVersion ~= PROTOCOL_VERSION then
  return failure("studio.response_invalid", "Unsupported bridge protocol version.")
end
if payload.action == "probe" then return probeAction() end
local gateFailure = sandboxGate()
if gateFailure ~= nil then return gateFailure end
if payload.action == "snapshot" then return snapshotAction() end
if payload.action == "create" then return createAction() end
if payload.action == "update" then return updateAction() end
if payload.action == "delete" then return deleteAction() end
return failure("studio.response_invalid", "Unsupported fixed bridge action.")
`;

export function buildStudioBridgeProgram(request: StudioBridgeRequest): FixedStudioBridgeProgram {
  const encoded = encodeStudioBridgePayload(request);
  const markerIndex = FIXED_STUDIO_BRIDGE.indexOf(PAYLOAD_MARKER);
  if (
    markerIndex < 0 ||
    FIXED_STUDIO_BRIDGE.indexOf(PAYLOAD_MARKER, markerIndex + PAYLOAD_MARKER.length) >= 0
  ) {
    throw new Error('Fixed Studio bridge payload marker invariant failed.');
  }
  const source = FIXED_STUDIO_BRIDGE.replace(PAYLOAD_MARKER, () => encoded.literal);
  return issueFixedStudioBridgeProgram(source);
}
