import type { AreaProjection, SpatialRef, WorldEntity, WorldRelation } from '../worldbridge/contract.js';

export interface ProviderVisibleRouteAlternative {
  id: string;
  kind: 'provider-topology';
  nodeEntityIds: string[];
  relationIds: string[];
  evidenceIds: string[];
  waypointEntityIds: string[];
  waypoints: SpatialRef[];
  /** Relation responsible for each physical waypoint; aligned with waypointEntityIds/waypoints. */
  waypointRelationIds: string[];
  /** Provider tick at which this topology basis was observed. */
  basisTick: number;
  /** Topology-critical signatures aligned with relationIds. */
  relationSignatures: string[];
  distanceKm: number;
  /** Length ratio relative to the shortest provider-visible alternative. */
  stretchFromShortest: number;
  /** Distance-weighted fraction of the shortest route's relations reused by this alternative. */
  overlapWithShortest: number;
}

interface GraphEdge {
  relationId: string;
  from: string;
  to: string;
  distanceKm: number;
  evidenceIds: string[];
  relationSignature: string;
  viaEntityId?: string;
  viaSpatial?: SpatialRef;
}

interface GraphPath {
  nodes: string[];
  edges: GraphEdge[];
  cost: number;
}

const EPSILON = 1e-9;

function spatialDistanceKm(a: SpatialRef, b: SpatialRef): number {
  if (a.frameId !== b.frameId) return Number.POSITIVE_INFINITY;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function relationDataString(relation: WorldRelation, key: string): string | undefined {
  const value = relation.data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const CLOSED_ROUTE_STATUSES = new Set(['closed', 'blocked', 'impassable', 'ended', 'removed', 'destroyed', 'unusable']);

function relationDataBoolean(relation: WorldRelation, key: string): boolean | undefined {
  const value = relation.data?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Only explicit provider statements can make a previously known topology edge unusable.
 * Absence from an observer-bounded projection is deliberately not treated as removal.
 */
export function providerRelationExplicitPassability(relation: WorldRelation, tick: number): { traversable: boolean; reason?: string } {
  if (relation.endTick !== undefined && relation.endTick <= tick) return { traversable: false, reason: `relation ended at provider tick ${relation.endTick}` };
  for (const key of ['passable', 'traversable', 'enabled', 'active'] as const) {
    if (relationDataBoolean(relation, key) === false) return { traversable: false, reason: `provider relation data explicitly sets ${key}=false` };
  }
  const status = relationDataString(relation, 'status')?.toLowerCase();
  if (status && CLOSED_ROUTE_STATUSES.has(status)) return { traversable: false, reason: `provider relation status=${status}` };
  return { traversable: true };
}

/** Stable text signature for topology fields that materially affect route execution/cost. */
export function providerRouteRelationSignature(relation: WorldRelation): string {
  const data = relation.data ?? {};
  const normalized = [
    relation.kind, relation.sourceId, relation.targetId, relation.startTick ?? null, relation.endTick ?? null,
    typeof data.routeId === 'string' ? data.routeId : null,
    typeof data.distanceKm === 'number' && Number.isFinite(data.distanceKm) ? data.distanceKm : null,
    typeof data.status === 'string' ? data.status.toLowerCase() : null,
    typeof data.passable === 'boolean' ? data.passable : null,
    typeof data.traversable === 'boolean' ? data.traversable : null,
    typeof data.enabled === 'boolean' ? data.enabled : null,
    typeof data.active === 'boolean' ? data.active : null,
  ];
  return JSON.stringify(normalized);
}

export interface ProviderVisibleRouteInvalidation {
  relationId: string;
  reason: string;
  evidenceIds: string[];
}

/**
 * Detects only positive invalidation evidence for relations that are actually present in the current
 * observer-bounded projection. Missing relations remain epistemically unknown and do not invalidate.
 */
export function providerVisibleRouteInvalidations(
  projection: AreaProjection | null | undefined,
  relationIds: string[],
  expectedSignatures: string[] = [],
): ProviderVisibleRouteInvalidation[] {
  if (!projection || !relationIds.length) return [];
  const expected = new Map(relationIds.map((id, index) => [id, expectedSignatures[index]]));
  const remaining = new Set(relationIds);
  const invalidations: ProviderVisibleRouteInvalidation[] = [];
  for (const relation of projection.relations) {
    if (!remaining.has(relation.id)) continue;
    const passability = providerRelationExplicitPassability(relation, projection.tick);
    if (!passability.traversable) {
      invalidations.push({ relationId: relation.id, reason: passability.reason ?? 'provider explicitly marked relation unusable', evidenceIds: [relation.id, ...relation.provenanceIds] });
      continue;
    }
    const prior = expected.get(relation.id);
    if (prior && prior !== providerRouteRelationSignature(relation)) {
      invalidations.push({ relationId: relation.id, reason: 'provider-visible topology/cost signature changed', evidenceIds: [relation.id, ...relation.provenanceIds] });
    }
  }
  return invalidations.sort((a, b) => a.relationId.localeCompare(b.relationId) || a.reason.localeCompare(b.reason));
}

function relationDistanceKm(relation: WorldRelation, source: WorldEntity, target: WorldEntity, via?: WorldEntity): number {
  const explicit = Number(relation.data?.distanceKm);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (!source.spatial || !target.spatial) return Number.POSITIVE_INFINITY;
  if (via?.spatial) {
    const first = spatialDistanceKm(source.spatial, via.spatial);
    const second = spatialDistanceKm(via.spatial, target.spatial);
    return Number.isFinite(first) && Number.isFinite(second) ? first + second : Number.POSITIVE_INFINITY;
  }
  return spatialDistanceKm(source.spatial, target.spatial);
}

function topologyEdgeForRelation(relation: WorldRelation, entities: Map<string, WorldEntity>, tick: number): GraphEdge | undefined {
  if (!providerRelationExplicitPassability(relation, tick).traversable) return undefined;
  const source = entities.get(relation.sourceId);
  const target = entities.get(relation.targetId);
  if (!source?.spatial || !target?.spatial) return undefined;

  let routeEntity: WorldEntity | undefined;
  if (relation.kind === 'route-link') {
    // route-link is explicit provider topology; no additional inference is made.
  } else if (relation.kind === 'connects') {
    const routeId = relationDataString(relation, 'routeId');
    routeEntity = routeId ? entities.get(routeId) : undefined;
    if (!routeEntity || routeEntity.kind !== 'route' || !routeEntity.spatial) return undefined;
  } else return undefined;

  const distanceKm = relationDistanceKm(relation, source, target, routeEntity);
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return undefined;
  const evidenceIds = [relation.id, ...(routeEntity ? [routeEntity.id] : [])];
  return {
    relationId: relation.id,
    from: relation.sourceId,
    to: relation.targetId,
    distanceKm,
    evidenceIds,
    relationSignature: providerRouteRelationSignature(relation),
    ...(routeEntity?.spatial ? { viaEntityId: routeEntity.id, viaSpatial: structuredClone(routeEntity.spatial) } : {}),
  };
}

function directedEdgeKey(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.relationId}`;
}

function pathSignature(path: GraphPath): string {
  return `${path.nodes.join('>')}|${path.edges.map((edge) => edge.relationId).join('>')}`;
}

function rootMatches(path: GraphPath, rootNodes: string[]): boolean {
  if (path.nodes.length < rootNodes.length) return false;
  for (let i = 0; i < rootNodes.length; i += 1) if (path.nodes[i] !== rootNodes[i]) return false;
  return true;
}

function pathCost(edges: GraphEdge[]): number {
  return edges.reduce((sum, edge) => sum + edge.distanceKm, 0);
}

function shortestPath(
  adjacency: Map<string, GraphEdge[]>,
  startId: string,
  targetId: string,
  bannedNodes: Set<string>,
  bannedDirectedEdges: Set<string>,
): GraphPath | undefined {
  if (bannedNodes.has(startId) || bannedNodes.has(targetId)) return undefined;
  type Candidate = { nodeId: string; cost: number; nodes: string[]; edges: GraphEdge[]; signature: string };
  const queue: Candidate[] = [{ nodeId: startId, cost: 0, nodes: [startId], edges: [], signature: startId }];
  const best = new Map<string, { cost: number; signature: string }>();

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.signature.localeCompare(b.signature));
    const current = queue.shift()!;
    const prior = best.get(current.nodeId);
    if (prior && (prior.cost < current.cost - EPSILON || (Math.abs(prior.cost - current.cost) <= EPSILON && prior.signature <= current.signature))) continue;
    best.set(current.nodeId, { cost: current.cost, signature: current.signature });
    if (current.nodeId === targetId) return { nodes: current.nodes, edges: current.edges, cost: current.cost };

    for (const edge of adjacency.get(current.nodeId) ?? []) {
      if (bannedNodes.has(edge.to) || bannedDirectedEdges.has(directedEdgeKey(edge))) continue;
      if (current.nodes.includes(edge.to)) continue;
      const nextCost = current.cost + edge.distanceKm;
      const nextNodes = [...current.nodes, edge.to];
      const nextEdges = [...current.edges, edge];
      const signature = `${nextNodes.join('>')}|${nextEdges.map((item) => item.relationId).join('>')}`;
      queue.push({ nodeId: edge.to, cost: nextCost, nodes: nextNodes, edges: nextEdges, signature });
    }
  }
  return undefined;
}

function kShortestLooplessPaths(adjacency: Map<string, GraphEdge[]>, startId: string, targetId: string, k: number): GraphPath[] {
  const first = shortestPath(adjacency, startId, targetId, new Set(), new Set());
  if (!first) return [];
  const accepted: GraphPath[] = [first];
  const acceptedSignatures = new Set([pathSignature(first)]);
  const candidates = new Map<string, GraphPath>();

  while (accepted.length < k) {
    const previous = accepted[accepted.length - 1]!;
    for (let spurIndex = 0; spurIndex < previous.nodes.length - 1; spurIndex += 1) {
      const rootNodes = previous.nodes.slice(0, spurIndex + 1);
      const rootEdges = previous.edges.slice(0, spurIndex);
      const spurNode = rootNodes[rootNodes.length - 1]!;
      const bannedEdges = new Set<string>();
      for (const path of accepted) {
        if (!rootMatches(path, rootNodes) || !path.edges[spurIndex]) continue;
        bannedEdges.add(directedEdgeKey(path.edges[spurIndex]!));
      }
      const bannedNodes = new Set(rootNodes.slice(0, -1));
      const spur = shortestPath(adjacency, spurNode, targetId, bannedNodes, bannedEdges);
      if (!spur) continue;
      const combined: GraphPath = {
        nodes: [...rootNodes.slice(0, -1), ...spur.nodes],
        edges: [...rootEdges, ...spur.edges],
        cost: pathCost(rootEdges) + spur.cost,
      };
      const signature = pathSignature(combined);
      if (!acceptedSignatures.has(signature)) candidates.set(signature, combined);
    }
    if (!candidates.size) break;
    const next = [...candidates.entries()].sort((a, b) => a[1].cost - b[1].cost || a[0].localeCompare(b[0]))[0]!;
    candidates.delete(next[0]);
    accepted.push(next[1]);
    acceptedSignatures.add(next[0]);
  }
  return accepted;
}

function routeAlternativeFromPath(
  path: GraphPath,
  targetEntityId: string,
  entities: Map<string, WorldEntity>,
  shortestPath: GraphPath,
  basisTick: number,
): ProviderVisibleRouteAlternative {
  const waypointEntityIds: string[] = [];
  const waypoints: SpatialRef[] = [];
  const waypointRelationIds: string[] = [];
  for (const edge of path.edges) {
    if (edge.viaEntityId && edge.viaSpatial) {
      waypointEntityIds.push(edge.viaEntityId);
      waypoints.push(structuredClone(edge.viaSpatial));
      waypointRelationIds.push(edge.relationId);
    }
    if (edge.to !== targetEntityId) {
      const entity = entities.get(edge.to);
      if (entity?.spatial) {
        waypointEntityIds.push(entity.id);
        waypoints.push(structuredClone(entity.spatial));
        waypointRelationIds.push(edge.relationId);
      }
    }
  }
  const relationIds = path.edges.map((edge) => edge.relationId);
  const evidenceIds = [...new Set(path.edges.flatMap((edge) => edge.evidenceIds))];
  const shortestRelations = new Set(shortestPath.edges.map((edge) => edge.relationId));
  const sharedDistanceKm = path.edges.filter((edge) => shortestRelations.has(edge.relationId)).reduce((sum, edge) => sum + edge.distanceKm, 0);
  const shortestDistance = Math.max(EPSILON, shortestPath.cost);
  return {
    id: `topology:${relationIds.join('>')}`,
    kind: 'provider-topology',
    nodeEntityIds: [...path.nodes],
    relationIds,
    evidenceIds,
    waypointEntityIds,
    waypoints,
    waypointRelationIds,
    basisTick,
    relationSignatures: path.edges.map((edge) => edge.relationSignature),
    distanceKm: path.cost,
    stretchFromShortest: path.cost / shortestDistance,
    overlapWithShortest: Math.max(0, Math.min(1, sharedDistanceKm / shortestDistance)),
  };
}

/**
 * Builds route alternatives only from observer-bounded provider topology whose two endpoint entities
 * are already visible to the caller. No geometric proximity edge is invented. The direct option is
 * intentionally handled by the caller as an epistemically-unknown traversal rather than a known route.
 */
export function providerVisibleRouteAlternatives(
  projection: AreaProjection | null | undefined,
  visibleEntities: WorldEntity[],
  originEntityId: string,
  targetEntityId: string,
  maxAlternatives = 3,
): ProviderVisibleRouteAlternative[] {
  if (!projection || maxAlternatives <= 0 || originEntityId === targetEntityId) return [];
  const entities = new Map(visibleEntities.filter((entity) => entity.spatial).map((entity) => [entity.id, entity]));
  if (!entities.has(originEntityId) || !entities.has(targetEntityId)) return [];
  const adjacency = new Map<string, GraphEdge[]>();
  for (const relation of projection.relations) {
    const edge = topologyEdgeForRelation(relation, entities, projection.tick);
    if (!edge) continue;
    const reverse: GraphEdge = { ...edge, from: edge.to, to: edge.from };
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from)!.push(edge);
    adjacency.get(edge.to)!.push(reverse);
  }
  for (const edges of adjacency.values()) edges.sort((a, b) => a.distanceKm - b.distanceKm || a.relationId.localeCompare(b.relationId) || a.to.localeCompare(b.to));
  const paths = kShortestLooplessPaths(adjacency, originEntityId, targetEntityId, Math.max(1, Math.floor(maxAlternatives)));
  if (!paths.length) return [];
  return paths.map((path) => routeAlternativeFromPath(path, targetEntityId, entities, paths[0]!, projection.tick));
}
