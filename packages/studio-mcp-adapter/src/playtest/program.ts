import {
  STUDIO_MCP_MAX_MANAGED_NODES,
  STUDIO_MCP_MAX_WORKSPACE_SCAN_INSTANCES,
  STUDIO_MCP_PLAYTEST_MAX_MANAGED_BLOCKERS,
  STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION,
  STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX,
  STUDIO_SANDBOX_LEASE_ATTRIBUTE_NAME,
  STUDIO_SANDBOX_LEASE_RECORD_VERSION,
} from '../constants.js';
import { StudioAdapterError } from '../diagnostics.js';
import { encodeLuauLongBracketLiteral } from '../bridge/literal.js';
import { issueFixedStudioPlaytestProgram, type FixedStudioPlaytestProgram } from '../mcp/client.js';
import { stringifyStudioPlaytestProbeRequest } from './normalize.js';
import type { StudioPlaytestProbeRequest } from './types.js';
import { validateStudioPlaytestProbeRequest } from './validate.js';

const PAYLOAD_MARKER = '__WORLDWRIGHT_PLAYTEST_VALIDATED_PAYLOAD__';

const FIXED_STUDIO_PLAYTEST_PROGRAM = String.raw`local HttpService = game:GetService("HttpService")
local PathfindingService = game:GetService("PathfindingService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local PROTOCOL_VERSION = ${JSON.stringify(STUDIO_PLAYTEST_PROBE_PROTOCOL_VERSION)}
local RESPONSE_PREFIX = ${JSON.stringify(STUDIO_PLAYTEST_PROBE_RESPONSE_PREFIX)}
local SANDBOX_LEASE_ATTRIBUTE = ${JSON.stringify(STUDIO_SANDBOX_LEASE_ATTRIBUTE_NAME)}
local SANDBOX_LEASE_VERSION = ${JSON.stringify(STUDIO_SANDBOX_LEASE_RECORD_VERSION)}
local MAX_MANAGED_NODES = ${STUDIO_MCP_MAX_MANAGED_NODES}
local MAX_SCAN_INSTANCES = ${STUDIO_MCP_MAX_WORKSPACE_SCAN_INSTANCES}
local MAX_MANAGED_BLOCKERS = ${STUDIO_MCP_PLAYTEST_MAX_MANAGED_BLOCKERS}
local payloadJson = ${PAYLOAD_MARKER}
local ARRAY_MT = {}

local function array(values)
  return setmetatable(values or {}, ARRAY_MT)
end

local function canonicalJson(value)
  local valueType = typeof(value)
  if value == nil then return "null" end
  if valueType == "boolean" or valueType == "number" or valueType == "string" then
    return HttpService:JSONEncode(value)
  end
  if valueType ~= "table" then error("unsupported JSON value") end
  if getmetatable(value) == ARRAY_MT then
    if #value == 0 then return "[]" end
    local encoded = table.create(#value)
    for index, entry in ipairs(value) do encoded[index] = canonicalJson(entry) end
    return "[" .. table.concat(encoded, ",") .. "]"
  end
  local keys = {}
  for key in pairs(value) do
    if typeof(key) ~= "string" then error("object key must be a string") end
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
  return RESPONSE_PREFIX .. canonicalJson(response) .. "\n"
end

local payload = nil
local decoded, decodedValue = pcall(function() return HttpService:JSONDecode(payloadJson) end)
if decoded then payload = decodedValue end
local action = typeof(payload) == "table" and payload.action or "identity_probe"

local function failure(code, message)
  return reply({
    protocolVersion = PROTOCOL_VERSION,
    action = action,
    ok = false,
    diagnostic = { code = code, message = message },
  })
end

local function success(fields)
  fields.protocolVersion = PROTOCOL_VERSION
  fields.action = action
  fields.ok = true
  return reply(fields)
end

local function finite(value)
  return typeof(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function lowerSha(value)
  if typeof(value) ~= "string" or #value ~= 64 then return false end
  for index = 1, #value do
    local byte = string.byte(value, index)
    if not ((byte >= 48 and byte <= 57) or (byte >= 97 and byte <= 102)) then return false end
  end
  return true
end

local function identifier(value)
  if typeof(value) ~= "string" or #value < 1 or #value > 128 then return false end
  if string.match(value, "^[a-z][a-z0-9%-]*$") == nil then return false end
  return string.sub(value, -1) ~= "-" and string.find(value, "--", 1, true) == nil
end

local function vector(value)
  return typeof(value) == "table" and finite(value.x) and finite(value.y) and finite(value.z)
end

local function canonicalLease(record)
  return "{\n"
    .. "  \"changeSetHash\": " .. HttpService:JSONEncode(record.changeSetHash) .. ",\n"
    .. "  \"leaseId\": " .. HttpService:JSONEncode(record.leaseId) .. ",\n"
    .. "  \"projectId\": " .. HttpService:JSONEncode(record.projectId) .. ",\n"
    .. "  \"schemaVersion\": " .. HttpService:JSONEncode(record.schemaVersion) .. "\n"
    .. "}\n"
end

local function identityPayloadValid(identity)
  if typeof(identity) ~= "table"
    or not identifier(identity.projectId)
    or not identifier(identity.rootNodeId)
    or not lowerSha(identity.manifestSourceWorldSpecSha256)
    or not finite(identity.expectedManagedNodeCount)
    or identity.expectedManagedNodeCount % 1 ~= 0
    or identity.expectedManagedNodeCount < 1
    or identity.expectedManagedNodeCount > MAX_MANAGED_NODES
    or not lowerSha(identity.playtestPlanSha256)
    or typeof(identity.sandboxLease) ~= "table" then
    return false
  end
  local lease = identity.sandboxLease
  return lease.schemaVersion == SANDBOX_LEASE_VERSION
    and lowerSha(lease.leaseId)
    and lease.projectId == identity.projectId
    and lowerSha(lease.changeSetHash)
end

local function characterParts()
  local players = Players:GetPlayers()
  if #players ~= 1 then return players, nil, nil, nil end
  local character = players[1].Character
  if character == nil or not character:IsA("Model") then return players, character, nil, nil end
  local humanoid = character:FindFirstChildOfClass("Humanoid")
  local root = character:FindFirstChild("HumanoidRootPart")
  if root ~= nil and not root:IsA("BasePart") then root = nil end
  return players, character, humanoid, root
end

local function characterReady(character, humanoid, root)
  return character ~= nil
    and humanoid ~= nil
    and root ~= nil
    and finite(humanoid.Health)
    and humanoid.Health > 0
    and humanoid:GetState() ~= Enum.HumanoidStateType.Dead
end

local function verifyPlayIdentity(identity)
  if not identityPayloadValid(identity) then return nil, "studio.playtest_probe_invalid" end
  if game.PlaceId ~= 0 or game.GameId ~= 0 then
    return nil, "studio.published_place_forbidden"
  end
  if not RunService:IsStudio() or not RunService:IsRunning() or not RunService:IsServer() then
    return nil, "studio.playtest_identity_mismatch"
  end

  local leaseRead, rawLease = pcall(function()
    return Workspace:GetAttribute(SANDBOX_LEASE_ATTRIBUTE)
  end)
  if not leaseRead or typeof(rawLease) ~= "string" or #rawLease > 1024 then
    return nil, "studio.playtest_identity_mismatch"
  end
  if rawLease ~= canonicalLease(identity.sandboxLease) then
    return nil, "studio.playtest_identity_mismatch"
  end

  local pending = Workspace:GetChildren()
  if #pending > MAX_SCAN_INSTANCES then return nil, "studio.node_limit_exceeded" end
  local cursor = 1
  local selected = {}
  local selectedCount = 0
  local root = nil
  local ids = {}
  while cursor <= #pending do
    local instance = pending[cursor]
    cursor += 1
    local managed = instance:GetAttribute("WorldwrightManaged") == true
      and instance:GetAttribute("WorldwrightProjectId") == identity.projectId
    if managed then
      selectedCount += 1
      if selectedCount > MAX_MANAGED_NODES then return nil, "studio.node_limit_exceeded" end
      local entityId = instance:GetAttribute("WorldwrightEntityId")
      if not identifier(entityId) or ids[entityId] ~= nil then
        return nil, "studio.playtest_identity_mismatch"
      end
      ids[entityId] = instance
      selected[instance] = true
      if instance.Parent == Workspace then
        if root ~= nil then return nil, "studio.playtest_identity_mismatch" end
        root = instance
      end
    end
    local children = instance:GetChildren()
    if #pending + #children > MAX_SCAN_INSTANCES then
      return nil, "studio.node_limit_exceeded"
    end
    for _, child in ipairs(children) do table.insert(pending, child) end
  end
  if selectedCount ~= identity.expectedManagedNodeCount
    or root == nil
    or root:GetAttribute("WorldwrightEntityId") ~= identity.rootNodeId
    or root:GetAttribute("WorldwrightSourceHash") ~= identity.manifestSourceWorldSpecSha256
    or (not root:IsA("Folder") and not root:IsA("Model")) then
    return nil, "studio.playtest_identity_mismatch"
  end
  for instance in pairs(selected) do
    if instance ~= root then
      local parent = instance.Parent
      if parent == nil or selected[parent] ~= true or (not parent:IsA("Folder") and not parent:IsA("Model")) then
        return nil, "studio.playtest_identity_mismatch"
      end
    end
  end
  return { root = root, index = ids, count = selectedCount }, nil
end

local function requireCharacterComponents()
  local players, character, humanoid, root = characterParts()
  if #players ~= 1 or character == nil or humanoid == nil or root == nil then
    return nil, nil, nil, "studio.playtest_character_unavailable"
  end
  return character, humanoid, root, nil
end

local function requireCharacter()
  local character, humanoid, root, characterError = requireCharacterComponents()
  if characterError ~= nil or not characterReady(character, humanoid, root) then
    return nil, nil, nil, "studio.playtest_character_unavailable"
  end
  return character, humanoid, root, nil
end

local function managedEntityId(instance, identity)
  if instance == nil
    or instance:GetAttribute("WorldwrightManaged") ~= true
    or instance:GetAttribute("WorldwrightProjectId") ~= identity.projectId then
    return nil
  end
  local entityId = instance:GetAttribute("WorldwrightEntityId")
  return identifier(entityId) and entityId or nil
end

local function raycastSupport(character, root, identity, maximumDistance)
  local parameters = RaycastParams.new()
  parameters.FilterType = Enum.RaycastFilterType.Exclude
  parameters.FilterDescendantsInstances = { character }
  parameters.IgnoreWater = false
  parameters.RespectCanCollide = true
  local result = Workspace:Raycast(root.Position, Vector3.new(0, -maximumDistance, 0), parameters)
  if result == nil or not result.Instance.CanCollide then return false, nil, nil end
  return true, (root.Position - result.Position).Magnitude, managedEntityId(result.Instance, identity)
end

local function identityAction(identity)
  local verified, identityError = verifyPlayIdentity(identity)
  if verified == nil then
    return failure(identityError, "The running Studio simulation does not match the expected sandbox.")
  end
  local players, character, humanoid, root = characterParts()
  if #players > 16 then
    return failure("studio.playtest_character_unavailable", "The bounded local Player limit was exceeded.")
  end
  return success({
    projectIdentityMatched = true,
    rootIdentityMatched = true,
    managedNodeCount = verified.count,
    playerCount = #players,
    characterReady = characterReady(character, humanoid, root),
    dataModelType = "Server",
    playRunning = true,
  })
end

local function characterSetupAction(identity)
  local verified, identityError = verifyPlayIdentity(identity)
  if verified == nil then
    return failure(identityError, "The running Studio simulation does not match the expected sandbox.")
  end
  if not vector(payload.setupPosition) then
    return failure("studio.playtest_probe_invalid", "The fixed character setup position is invalid.")
  end
  local character, _, root, characterError = requireCharacter()
  if characterError ~= nil then
    return failure(characterError, "Exactly one ready local test character is required.")
  end
  local target = Vector3.new(payload.setupPosition.x, payload.setupPosition.y, payload.setupPosition.z)
  local moved = pcall(function()
    character:PivotTo(character:GetPivot() + (target - root.Position))
    root.AssemblyLinearVelocity = Vector3.zero
    root.AssemblyAngularVelocity = Vector3.zero
  end)
  if not moved or (root.Position - target).Magnitude > 0.01 then
    return failure("studio.playtest_character_unavailable", "The fixed character setup could not be verified.")
  end
  return success({
    position = { x = root.Position.X, y = root.Position.Y, z = root.Position.Z },
    linearVelocityMagnitude = root.AssemblyLinearVelocity.Magnitude,
    angularVelocityMagnitude = root.AssemblyAngularVelocity.Magnitude,
  })
end

local function playerStateAction(identity)
  local verified, identityError = verifyPlayIdentity(identity)
  if verified == nil then
    return failure(identityError, "The running Studio simulation does not match the expected sandbox.")
  end
  if typeof(payload.agent) ~= "table" or typeof(payload.floors) ~= "table" then
    return failure("studio.playtest_probe_invalid", "The fixed player-state payload is invalid.")
  end
  local character, humanoid, root, characterError = requireCharacterComponents()
  if characterError ~= nil then
    return failure(characterError, "Exactly one observable local test character is required.")
  end
  if not finite(humanoid.Health) or not finite(humanoid.MaxHealth)
    or humanoid.Health < 0 or humanoid.MaxHealth < 0 or humanoid.Health > humanoid.MaxHealth then
    return failure("studio.playtest_probe_invalid", "The observed Humanoid health is invalid.")
  end
  local supportDistance = payload.agent.rootHeightAboveFinishedFloor + payload.agent.maximumFallBelowFloor
  if not finite(supportDistance) or supportDistance <= 0 then
    return failure("studio.playtest_probe_invalid", "The fixed player-state support bound is invalid.")
  end
  local supported, distance, supportId = raycastSupport(character, root, identity, supportDistance)
  local floorElevation = root.Position.Y - payload.agent.rootHeightAboveFinishedFloor
  local closest = nil
  local closestDelta = math.huge
  for _, floor in ipairs(payload.floors) do
    if typeof(floor) ~= "table" or not identifier(floor.floorId)
      or not finite(floor.level) or floor.level % 1 ~= 0
      or not finite(floor.finishedFloorElevation) then
      return failure("studio.playtest_probe_invalid", "The fixed floor classification payload is invalid.")
    end
    local delta = math.abs(floorElevation - floor.finishedFloorElevation)
    if delta < closestDelta then closest, closestDelta = floor, delta end
  end
  if closestDelta > payload.agent.arrivalVerticalTolerance then closest = nil end
  local response = {
    position = { x = root.Position.X, y = root.Position.Y, z = root.Position.Z },
    linearVelocityMagnitude = root.AssemblyLinearVelocity.Magnitude,
    health = humanoid.Health,
    maximumHealth = humanoid.MaxHealth,
    humanoidState = humanoid:GetState().Name,
    floorMaterial = humanoid.FloorMaterial.Name,
    hasHumanoidRootPart = true,
    alive = humanoid.Health > 0 and humanoid:GetState() ~= Enum.HumanoidStateType.Dead,
    supported = supported,
    supportDistance = distance,
    currentLevel = closest and closest.level or nil,
  }
  if supportId ~= nil then response.managedSupportEntityId = supportId end
  if closest ~= nil then response.currentFloorId = closest.floorId end
  return success(response)
end

local function pathProbeAction(identity)
  local verified, identityError = verifyPlayIdentity(identity)
  if verified == nil then
    return failure(identityError, "The running Studio simulation does not match the expected sandbox.")
  end
  if not identifier(payload.fromCheckpointId)
    or not identifier(payload.targetCheckpointId)
    or payload.fromCheckpointId == payload.targetCheckpointId
    or not vector(payload.fromWorldPosition)
    or not vector(payload.targetWorldPosition)
    or typeof(payload.agent) ~= "table"
    or not finite(payload.maximumRetainedWaypoints)
    or payload.maximumRetainedWaypoints % 1 ~= 0
    or payload.maximumRetainedWaypoints < 1
    or payload.maximumRetainedWaypoints > 128 then
    return failure("studio.playtest_probe_invalid", "The fixed path probe payload is invalid.")
  end
  local _, _, root, characterError = requireCharacter()
  if characterError ~= nil then
    return failure(characterError, "Exactly one ready local test character is required.")
  end
  local target = Vector3.new(
    payload.targetWorldPosition.x,
    payload.targetWorldPosition.y,
    payload.targetWorldPosition.z
  )
  local expectedFrom = Vector3.new(
    payload.fromWorldPosition.x,
    payload.fromWorldPosition.y,
    payload.fromWorldPosition.z
  )
  local horizontalFromError = Vector2.new(root.Position.X - expectedFrom.X, root.Position.Z - expectedFrom.Z).Magnitude
  local verticalFromError = math.abs(root.Position.Y - expectedFrom.Y)
  if horizontalFromError > payload.agent.arrivalHorizontalTolerance
    or verticalFromError > payload.agent.arrivalVerticalTolerance then
    return failure("studio.playtest_character_unavailable", "The character is not at the exact path source checkpoint.")
  end
  local computed, path = pcall(function()
    local candidate = PathfindingService:CreatePath({
      AgentRadius = payload.agent.radius,
      AgentHeight = payload.agent.height,
      AgentCanJump = false,
      AgentCanClimb = false,
      WaypointSpacing = payload.agent.waypointSpacing,
    })
    candidate:ComputeAsync(root.Position, target)
    return candidate
  end)
  local status = "computation_failed"
  local positions = array()
  local distance = 0
  local requiresJump = false
  local jumpWaypointCount = 0
  if computed and path.Status == Enum.PathStatus.Success then
    local waypoints = path:GetWaypoints()
    if #waypoints > payload.maximumRetainedWaypoints then
      status = "waypoint_limit_exceeded"
    else
      local previous = expectedFrom
      for _, waypoint in ipairs(waypoints) do
        table.insert(positions, {
          x = waypoint.Position.X,
          y = waypoint.Position.Y,
          z = waypoint.Position.Z,
        })
        distance += (waypoint.Position - previous).Magnitude
        previous = waypoint.Position
        if waypoint.Action == Enum.PathWaypointAction.Jump then
          requiresJump = true
          jumpWaypointCount += 1
        end
      end
      status = requiresJump and "jump_required" or "success"
    end
  elseif computed then
    status = "no_path"
  end
  return success({
    status = status,
    waypointCount = #positions,
    waypoints = positions,
    totalPathDistance = distance,
    requiresJump = requiresJump,
    jumpWaypointCount = jumpWaypointCount,
    fromCheckpointId = payload.fromCheckpointId,
    targetCheckpointId = payload.targetCheckpointId,
  })
end

local function clearanceProbeAction(identity)
  local verified, identityError = verifyPlayIdentity(identity)
  if verified == nil then
    return failure(identityError, "The running Studio simulation does not match the expected sandbox.")
  end
  if not identifier(payload.checkpointId)
    or not finite(payload.expectedFinishedFloorElevation)
    or typeof(payload.agent) ~= "table" then
    return failure("studio.playtest_probe_invalid", "The fixed clearance probe payload is invalid.")
  end
  local character, _, root, characterError = requireCharacter()
  if characterError ~= nil then
    return failure(characterError, "Exactly one ready local test character is required.")
  end
  local supportBound = payload.agent.rootHeightAboveFinishedFloor + payload.agent.maximumFallBelowFloor
  local supported, supportDistance, supportId = raycastSupport(character, root, identity, supportBound)
  if supported then
    local observedFloor = root.Position.Y - supportDistance
    supported = math.abs(observedFloor - payload.expectedFinishedFloorElevation)
      <= payload.agent.arrivalVerticalTolerance
  end

  local overlap = OverlapParams.new()
  overlap.FilterType = Enum.RaycastFilterType.Exclude
  overlap.FilterDescendantsInstances = { character }
  overlap.MaxParts = MAX_MANAGED_NODES + 1
  local bodyHeight = math.max(0.5, payload.agent.height - 0.5)
  local bodyWidth = math.max(0.5, payload.agent.radius * 2 - 0.5)
  local bodyCenter = root.Position + Vector3.new(
    0,
    bodyHeight / 2 - payload.agent.rootHeightAboveFinishedFloor + 0.25,
    0
  )
  local bodyParts = Workspace:GetPartBoundsInBox(
    CFrame.new(bodyCenter),
    Vector3.new(bodyWidth, bodyHeight, bodyWidth),
    overlap
  )
  local managedBlockers = {}
  local managedSeen = {}
  local unmanagedBlockerCount = 0
  for _, blocker in ipairs(bodyParts) do
    if blocker.CanCollide then
      local entityId = managedEntityId(blocker, identity)
      if entityId == nil then
        unmanagedBlockerCount += 1
      elseif managedSeen[entityId] ~= true then
        managedSeen[entityId] = true
        table.insert(managedBlockers, entityId)
      end
    end
  end
  if unmanagedBlockerCount > MAX_MANAGED_BLOCKERS then
    return failure("studio.playtest_clearance_failed", "Unmanaged clearance blocker limit exceeded.")
  end
  table.sort(managedBlockers)
  if #managedBlockers > MAX_MANAGED_BLOCKERS then
    return failure("studio.playtest_clearance_failed", "Managed clearance blocker limit exceeded.")
  end

  local raycast = RaycastParams.new()
  raycast.FilterType = Enum.RaycastFilterType.Exclude
  raycast.FilterDescendantsInstances = { character }
  raycast.RespectCanCollide = true
  local headDistance = math.max(0.25, payload.agent.height - payload.agent.rootHeightAboveFinishedFloor)
  local headHit = Workspace:Raycast(root.Position, Vector3.new(0, headDistance, 0), raycast)
  local response = {
    checkpointId = payload.checkpointId,
    supported = supported,
    supportDistance = supported and supportDistance or nil,
    bodyClear = #managedBlockers == 0 and unmanagedBlockerCount == 0,
    headClear = headHit == nil or not headHit.Instance.CanCollide,
    unmanagedBlockerCount = unmanagedBlockerCount,
    managedBlockerIds = array(managedBlockers),
  }
  if supported and supportId ~= nil then response.managedSupportEntityId = supportId end
  return success(response)
end

if typeof(payload) ~= "table" or payload.protocolVersion ~= PROTOCOL_VERSION
  or typeof(payload.action) ~= "string" or typeof(payload.identity) ~= "table" then
  return failure("studio.playtest_probe_invalid", "The fixed Studio playtest payload is invalid.")
end
if action == "identity_probe" then return identityAction(payload.identity) end
if action == "character_setup" then return characterSetupAction(payload.identity) end
if action == "player_state" then return playerStateAction(payload.identity) end
if action == "path_probe" then return pathProbeAction(payload.identity) end
if action == "clearance_probe" then return clearanceProbeAction(payload.identity) end
return failure("studio.playtest_probe_invalid", "The fixed Studio playtest action is unsupported.")`;

export function buildStudioPlaytestProbeProgram(requestInput: unknown): FixedStudioPlaytestProgram {
  const validation = validateStudioPlaytestProbeRequest(requestInput);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  const request: StudioPlaytestProbeRequest = validation.value;
  const encoded = encodeLuauLongBracketLiteral(stringifyStudioPlaytestProbeRequest(request));
  const markerIndex = FIXED_STUDIO_PLAYTEST_PROGRAM.indexOf(PAYLOAD_MARKER);
  if (
    markerIndex < 0 ||
    FIXED_STUDIO_PLAYTEST_PROGRAM.indexOf(PAYLOAD_MARKER, markerIndex + PAYLOAD_MARKER.length) >= 0
  ) {
    throw new Error('Fixed Studio playtest payload marker invariant failed.');
  }
  return issueFixedStudioPlaytestProgram(
    FIXED_STUDIO_PLAYTEST_PROGRAM.replace(PAYLOAD_MARKER, () => encoded),
  );
}
