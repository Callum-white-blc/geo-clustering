// ── Types ────────────────────────────────────────────────────────────────────

export interface GeoLocation {
  id: string;
  lat: number;
  lng: number;
  name?: string;
}

export interface Cluster {
  id: number;
  centroid: { lat: number; lng: number };
  points: GeoLocation[];
}

export interface RadiusResult {
  probe: GeoLocation & { clusterId: number };
  neighbours: { point: GeoLocation; clusterId: number; distKm: number }[];
  clusterIds: number[];
}

// ── Haversine distance (km) ──────────────────────────────────────────────────

export function haversine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const chord =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLng *
      sinLng;
  return R * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord));
}

// ── K-Means++ initialisation ─────────────────────────────────────────────────

function kMeansPlusPlusInit(
  points: GeoLocation[],
  k: number,
): { lat: number; lng: number }[] {
  const centroids: { lat: number; lng: number }[] = [];
  centroids.push(points[Math.floor(Math.random() * points.length)]);

  for (let c = 1; c < k; c++) {
    const dists = points.map((p) => {
      const d = Math.min(...centroids.map((c) => haversine(p, c)));
      return d * d;
    });
    const total = dists.reduce((a, b) => a + b, 0);
    let rand = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < dists.length; i++) {
      rand -= dists[i];
      if (rand <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push({ lat: points[chosen].lat, lng: points[chosen].lng });
  }

  return centroids;
}

// ── K-Means clustering ───────────────────────────────────────────────────────

export function kMeans(
  points: GeoLocation[],
  k: number,
  maxIter = 100,
): { lat: number; lng: number }[] {
  let centroids = kMeansPlusPlusInit(points, k);

  for (let iter = 0; iter < maxIter; iter++) {
    const assignments = points.map((p) => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < centroids.length; i++) {
        const d = haversine(p, centroids[i]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    });

    const newCentroids = centroids.map((_, ci) => {
      const members = points.filter((_, pi) => assignments[pi] === ci);
      if (members.length === 0) return centroids[ci];
      return {
        lat: members.reduce((s, p) => s + p.lat, 0) / members.length,
        lng: members.reduce((s, p) => s + p.lng, 0) / members.length,
      };
    });

    const moved = newCentroids.some(
      (c, i) =>
        Math.abs(c.lat - centroids[i].lat) > 1e-6 ||
        Math.abs(c.lng - centroids[i].lng) > 1e-6,
    );
    centroids = newCentroids;
    if (!moved) {
      console.log(`Converged after ${iter + 1} iterations`);
      break;
    }
  }

  return centroids;
}

// ── Size-constrained assignment ──────────────────────────────────────────────

export function assignWithCapacity(
  points: GeoLocation[],
  centroids: { lat: number; lng: number }[],
  maxSize: number,
): number[] {
  const k = centroids.length;
  const capacity = new Array(k).fill(maxSize);
  const assignments = new Array(points.length).fill(-1);

  const order = points
    .map((p, pi) => {
      const dists = centroids.map((c, ci) => ({ ci, d: haversine(p, c) }));
      dists.sort((a, b) => a.d - b.d);
      return { pi, dists };
    })
    .sort((a, b) => a.dists[0].d - b.dists[0].d);

  for (const { pi, dists } of order) {
    for (const { ci } of dists) {
      if (capacity[ci] > 0) {
        assignments[pi] = ci;
        capacity[ci]--;
        break;
      }
    }
  }

  return assignments;
}

// ── Build cluster objects ────────────────────────────────────────────────────

export function buildClusters(
  points: GeoLocation[],
  assignments: number[],
  centroids: { lat: number; lng: number }[],
): Cluster[] {
  const clusters: Cluster[] = centroids.map((centroid, id) => ({
    id,
    centroid,
    points: [],
  }));
  points.forEach((p, i) => clusters[assignments[i]].points.push(p));
  return clusters;
}

// ── Cluster (convenience) ────────────────────────────────────────────────────

export function clusterLocations(
  locations: GeoLocation[],
  targetSize: number,
  refineIter = 10,
): Cluster[] {
  const k = Math.ceil(locations.length / targetSize);

  // Phase 1: standard k-means to seed good centroids
  let centroids = kMeans(locations, k);

  // Phase 2: iteratively reassign with capacity then recompute centroids
  // from actual members. This pulls centroids toward their true geographic
  // population, preventing scattered outlier assignments.
  let assignments = assignWithCapacity(locations, centroids, targetSize);

  for (let i = 0; i < refineIter; i++) {
    const recomputed = centroids.map((prev, ci) => {
      const members = locations.filter((_, pi) => assignments[pi] === ci);
      if (members.length === 0) return prev;
      return {
        lat: members.reduce((s, p) => s + p.lat, 0) / members.length,
        lng: members.reduce((s, p) => s + p.lng, 0) / members.length,
      };
    });

    const next = assignWithCapacity(locations, recomputed, targetSize);

    const changed = next.some((a, i) => a !== assignments[i]);
    centroids = recomputed;
    assignments = next;

    if (!changed) {
      console.log(`Refinement converged after ${i + 1} iteration(s)`);
      break;
    }
  }

  return buildClusters(locations, assignments, centroids).filter(
    (c) => c.points.length > 0,
  );
}

// ── Stats ────────────────────────────────────────────────────────────────────

export function printStats(clusters: Cluster[]): void {
  const sizes = clusters.map((c) => c.points.length);
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;

  const avgRadius =
    clusters
      .map((c) => {
        if (c.points.length === 0) return 0;
        return (
          c.points.reduce((s, p) => s + haversine(p, c.centroid), 0) /
          c.points.length
        );
      })
      .reduce((a, b) => a + b, 0) / clusters.length;

  console.log(`\nClusters: ${clusters.length}`);
  console.log(`Points:   min=${min}  max=${max}  avg=${avg.toFixed(1)}`);
  console.log(`Avg radius (km): ${avgRadius.toFixed(1)}`);
}

// ── Radius analytics ────────────────────────────────────────────────────────

export function analyseRadius(
  clusters: Cluster[],
  radiusKm: number,
  sampleSize: number,
): void {
  const all: { point: GeoLocation; clusterId: number }[] = clusters.flatMap(
    (c) => c.points.map((p) => ({ point: p, clusterId: c.id })),
  );

  const probes = [...all].sort(() => Math.random() - 0.5).slice(0, sampleSize);

  console.log(
    `\n── Radius analysis: ${sampleSize} random probes, ${radiusKm}km radius ──`,
  );

  const results: RadiusResult[] = probes.map(({ point: probe, clusterId: probeCluster }) => {
    const neighbours = all
      .filter(({ point }) => point.id !== probe.id)
      .map(({ point, clusterId }) => ({
        point,
        clusterId,
        distKm: haversine(probe, point),
      }))
      .filter(({ distKm }) => distKm <= radiusKm)
      .sort((a, b) => a.distKm - b.distKm);

    const clusterIds = [...new Set(neighbours.map((n) => n.clusterId))];

    return { probe: { ...probe, clusterId: probeCluster }, neighbours, clusterIds };
  });

  for (const { probe, neighbours, clusterIds } of results) {
    console.log(
      `  ${probe.id} (cluster ${probe.clusterId + 1}) — ` +
        `${neighbours.length} neighbours across ${clusterIds.length} cluster(s)` +
        (clusterIds.length > 1
          ? `: [${clusterIds.map((id) => id + 1).join(', ')}]`
          : ''),
    );
  }

  const avgNeighbours = results.reduce((s, r) => s + r.neighbours.length, 0) / sampleSize;
  const clusterSpans = results.map((r) => r.clusterIds.length);
  const avgSpan = clusterSpans.reduce((a, b) => a + b, 0) / sampleSize;
  const maxSpan = Math.max(...clusterSpans);

  console.log(`\n  Summary:`);
  console.log(`    Avg neighbours within ${radiusKm}km: ${avgNeighbours.toFixed(1)}`);
  console.log(`    Avg clusters spanned:               ${avgSpan.toFixed(2)}`);
  console.log(`    Max clusters spanned by one probe:  ${maxSpan}`);
  console.log(
    `    Probes touching >1 cluster:         ` +
      `${results.filter((r) => r.clusterIds.length > 1).length} / ${sampleSize}`,
  );
}
