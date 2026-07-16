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
local MAX_RESULT_BYTES = 16777216
local EPSILON = 0.00001
local payloadJson = __WORLDWRIGHT_VALIDATED_PAYLOAD__
local payload = HttpService:JSONDecode(payloadJson)

local ARRAY_MT = {}
local function array(values)
  return setmetatable(values or {}, ARRAY_MT)
end

local function indent(depth)
  return string.rep("  ", depth)
end

local function canonicalJson(value, depth)
  depth = depth or 0
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
      encoded[index] = indent(depth + 1) .. canonicalJson(entry, depth + 1)
    end
    return "[\n" .. table.concat(encoded, ",\n") .. "\n" .. indent(depth) .. "]"
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
    encoded[index] = indent(depth + 1)
      .. HttpService:JSONEncode(key)
      .. ": "
      .. canonicalJson(value[key], depth + 1)
  end
  return "{\n" .. table.concat(encoded, ",\n") .. "\n" .. indent(depth) .. "}"
end

local function reply(response)
  local encoded = canonicalJson(response, 0)
  if #RESPONSE_PREFIX + #encoded + 1 > MAX_RESULT_BYTES then
    encoded = canonicalJson({
      protocolVersion = PROTOCOL_VERSION,
      action = payload.action,
      ok = false,
      diagnostic = {
        code = "studio.response_too_large",
        message = "Studio bridge response exceeded the bounded result size.",
      },
    }, 0)
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

local function isSafeStoredNodeShape(node)
  if typeof(node) ~= "table"
    or not hasOnlyKeys(node, NODE_KEYS)
    or not isIdentifier(node.id)
    or not isEntityKind(node.entityKind)
    or typeof(node.name) ~= "string"
    or node.name == ""
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
  if metadataError ~= nil then return false, metadataError, nil, nil end
  local verified, valid, propertyName = pcall(function()
    return verifyInstance(instance, node, stateJson, stateHash, index)
  end)
  if not verified then return false, "studio.adapter_metadata_invalid", nil, nil end
  if not valid then return false, "studio.engine_state_drift", propertyName, nil end
  return true, nil, nil, node
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

local function rawProperties(instance)
  if instance.ClassName == "Folder" or instance.ClassName == "Model" then return {} end
  local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = instance.CFrame:GetComponents()
  local result = {
    cframe = array({ x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 }),
    size = array({ instance.Size.X, instance.Size.Y, instance.Size.Z }),
    anchored = instance.Anchored,
    material = instance.Material.Name,
    color = array({ instance.Color.R, instance.Color.G, instance.Color.B }),
    transparency = instance.Transparency,
    canCollide = instance.CanCollide,
    canQuery = instance.CanQuery,
    canTouch = instance.CanTouch,
    castShadow = instance.CastShadow,
  }
  if instance.ClassName == "Part" then result.shape = instance.Shape.Name end
  return result
end

local function rawNode(instance, projectId)
  local parentKind = "other"
  local parentEntityId = nil
  if instance.Parent == Workspace then
    parentKind = "Workspace"
  elseif instance.Parent ~= nil and isSelectedManaged(instance.Parent, projectId) then
    parentKind = "managed"
    parentEntityId = instance.Parent:GetAttribute("WorldwrightEntityId")
  end
  local result = {
    entityId = instance:GetAttribute("WorldwrightEntityId"),
    projectId = instance:GetAttribute("WorldwrightProjectId"),
    className = instance.ClassName,
    name = instance.Name,
    parentKind = parentKind,
    entityKind = instance:GetAttribute("WorldwrightEntityKind"),
    compilerVersion = instance:GetAttribute("WorldwrightCompilerVersion"),
    adapterVersion = instance:GetAttribute("WorldwrightStudioAdapterVersion"),
    stateJson = instance:GetAttribute("WorldwrightStudioStateJson"),
    stateHash = instance:GetAttribute("WorldwrightStudioStateHash"),
    properties = rawProperties(instance),
  }
  if parentEntityId ~= nil then result.parentEntityId = parentEntityId end
  local sourceHash = instance:GetAttribute("WorldwrightSourceHash")
  if sourceHash ~= nil then result.sourceHash = sourceHash end
  return result
end

local function encodedStringBytes(value)
  local encoded, result = pcall(function() return HttpService:JSONEncode(value) end)
  if not encoded then return nil end
  return #result
end

local function snapshotAction()
  local projectId = payload.projectId
  local selected = array()
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
    local valid, validationCode, propertyName = verifyStoredManagedInstance(instance, projectId, projectIndex)
    if not valid then
      return failure(validationCode, "Managed instance state is invalid.", entityId, propertyName)
    end
    local stateJson = instance:GetAttribute("WorldwrightStudioStateJson")
    local stateBytes = encodedStringBytes(stateJson)
    local nameBytes = encodedStringBytes(instance.Name)
    local idBytes = encodedStringBytes(entityId)
    if stateBytes == nil or nameBytes == nil or idBytes == nil then
      return failure("studio.snapshot_invalid", "Managed snapshot strings could not be encoded safely.", entityId)
    end
    cumulativeMetadataBytes += stateBytes + nameBytes + idBytes + 1024
    if cumulativeMetadataBytes > MAX_RESULT_BYTES then
      return failure("studio.response_too_large", "Snapshot metadata exceeds the cumulative response budget.")
    end
    local observed, raw = pcall(function() return rawNode(instance, projectId) end)
    if not observed then
      return failure("studio.snapshot_invalid", "Managed engine state could not be observed safely.", entityId)
    end
    table.insert(selected, raw)
  end
  table.sort(selected, function(left, right) return left.entityId < right.entityId end)

  local unmanaged = array()
  for _, instance in ipairs(selectedInstances) do
    local parentId = instance:GetAttribute("WorldwrightEntityId")
    if typeof(parentId) ~= "string" or parentId == "" then
      return failure("studio.identity_invalid", "Managed parent ID is missing or invalid.")
    end
    local unmanagedChildren = {}
    for originalIndex, child in ipairs(selectedChildren[instance]) do
      if not isSelectedManaged(child, projectId) then
        if child.Name == "" then
          return failure("studio.snapshot_invalid", "Unmanaged root has an empty display name.", parentId)
        end
        table.insert(unmanagedChildren, {
          className = child.ClassName,
          name = child.Name,
          originalIndex = originalIndex,
        })
      end
    end
    table.sort(unmanagedChildren, function(left, right)
      if left.className ~= right.className then return left.className < right.className end
      if left.name ~= right.name then return left.name < right.name end
      return left.originalIndex < right.originalIndex
    end)
    local duplicateCounts = {}
    for _, child in ipairs(unmanagedChildren) do
      if #unmanaged >= MAX_NODES then
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
      local classBytes = encodedStringBytes(child.className)
      local nameBytes = encodedStringBytes(child.name)
      local pathBytes = encodedStringBytes(structuralPath)
      if classBytes == nil or nameBytes == nil or pathBytes == nil then
        return failure("studio.snapshot_invalid", "Unmanaged snapshot strings could not be encoded safely.", parentId)
      end
      cumulativeMetadataBytes += classBytes + nameBytes + pathBytes + 128
      if cumulativeMetadataBytes > MAX_RESULT_BYTES then
        return failure("studio.response_too_large", "Snapshot metadata exceeds the cumulative response budget.")
      end
      table.insert(unmanaged, {
        parentEntityId = parentId,
        className = child.className,
        name = child.name,
        structuralPath = structuralPath,
        ordinal = duplicateOrdinal,
      })
    end
  end
  table.sort(unmanaged, function(left, right) return left.structuralPath < right.structuralPath end)
  return success({ snapshot = { projectId = projectId, nodes = selected, unmanagedRoots = unmanaged } })
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
