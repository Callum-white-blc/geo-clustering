import * as fs from 'fs';
import * as path from 'path';
import {
  type GeoLocation,
  type Cluster,
  clusterLocations,
  printStats,
  analyseRadius,
} from './geo-clustering';

// ── HTML visualisation ───────────────────────────────────────────────────────

function generateHTML(clusters: Cluster[], outputPath: string) {
  const colours = clusters.map((_, i) => {
    const hue = (i * 360) / clusters.length;
    return `hsl(${hue},70%,50%)`;
  });

  const allPoints = clusters.flatMap((c) =>
    c.points.map((p) => ({ ...p, clusterId: c.id })),
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Geo Clusters</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #eee; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 20px; background: #16213e; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 1.1rem; color: #e94560; }
  .stat { font-size: 0.85rem; color: #aaa; }
  .stat span { color: #fff; font-weight: 600; }
  #map { flex: 1; position: relative; overflow: hidden; cursor: grab; }
  #map.dragging { cursor: grabbing; }
  canvas { position: absolute; top: 0; left: 0; }
  #tooltip {
    position: absolute; pointer-events: none; display: none;
    background: rgba(0,0,0,.85); border: 1px solid #444;
    border-radius: 6px; padding: 8px 12px; font-size: 0.8rem;
    max-width: 220px; z-index: 10;
  }
  #legend {
    position: absolute; bottom: 12px; right: 12px;
    background: rgba(22,33,62,.9); border: 1px solid #333;
    border-radius: 8px; padding: 10px 14px;
    max-height: 260px; overflow-y: auto; font-size: 0.75rem;
    min-width: 160px; z-index: 5;
  }
  #legend h3 { margin-bottom: 6px; font-size: 0.8rem; color: #aaa; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 3px 0; cursor: pointer; border-radius: 4px; padding: 2px 4px; }
  .legend-item:hover { background: rgba(255,255,255,.1); }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  #controls { position: absolute; top: 12px; left: 12px; display: flex; flex-direction: column; gap: 6px; z-index: 5; }
  button { background: #16213e; border: 1px solid #444; color: #eee; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 0.8rem; }
  button:hover { background: #e94560; border-color: #e94560; }
  #size-slider { display: flex; align-items: center; gap: 8px; background: rgba(22,33,62,.9); border: 1px solid #333; border-radius: 6px; padding: 6px 10px; font-size: 0.75rem; }
</style>
</head>
<body>
<header>
  <h1>Geo Clusters</h1>
  <div class="stat">Clusters: <span>${clusters.length}</span></div>
  <div class="stat">Total points: <span>${allPoints.length}</span></div>
  <div class="stat">Min size: <span>${Math.min(...clusters.map((c) => c.points.length))}</span></div>
  <div class="stat">Max size: <span>${Math.max(...clusters.map((c) => c.points.length))}</span></div>
  <div class="stat">Avg size: <span>${(allPoints.length / clusters.length).toFixed(1)}</span></div>
</header>
<div id="map">
  <canvas id="canvas"></canvas>
  <div id="tooltip"></div>
  <div id="controls">
    <button onclick="resetView()">Reset view</button>
    <button onclick="toggleCentroids()">Toggle centroids</button>
    <div id="size-slider">
      Point size: <input type="range" min="1" max="10" value="3" id="ptSize" oninput="ptSizeVal=+this.value;draw()"> <span id="ptSizeLabel">3</span>
    </div>
  </div>
  <div id="legend">
    <h3>Clusters (${clusters.length})</h3>
    <div id="legend-items"></div>
  </div>
</div>

<script>
const RAW_CLUSTERS = ${JSON.stringify(
    clusters.map((c, i) => ({
      id: c.id,
      colour: colours[i],
      centroid: c.centroid,
      size: c.points.length,
      points: c.points.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        id: p.id,
        name: p.name,
      })),
    })),
  )};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const mapEl = document.getElementById('map');

// ── Projection (Mercator) ────────────────────────────────────────────────────
function latLngToMercator(lat, lng) {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return { x, y };
}

const projectedClusters = RAW_CLUSTERS.map(c => ({
  ...c,
  centroidProj: latLngToMercator(c.centroid.lat, c.centroid.lng),
  points: c.points.map(p => ({ ...p, proj: latLngToMercator(p.lat, p.lng) }))
}));

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
projectedClusters.forEach(c => {
  c.points.forEach(p => {
    if (p.proj.x < minX) minX = p.proj.x;
    if (p.proj.x > maxX) maxX = p.proj.x;
    if (p.proj.y < minY) minY = p.proj.y;
    if (p.proj.y > maxY) maxY = p.proj.y;
  });
});

// ── View state ───────────────────────────────────────────────────────────────
let offsetX = 0, offsetY = 0, scale = 1;
let ptSizeVal = 3;
let showCentroids = true;
let highlightCluster = -1;

function resetView() {
  const W = canvas.width, H = canvas.height;
  const dataW = maxX - minX, dataH = maxY - minY;
  const pad = 0.05;
  scale = Math.min(W / (dataW * (1 + pad * 2)), H / (dataH * (1 + pad * 2)));
  offsetX = W / 2 - ((minX + maxX) / 2) * scale;
  offsetY = H / 2 - ((minY + maxY) / 2) * scale;
  draw();
}

function toggleCentroids() {
  showCentroids = !showCentroids;
  draw();
}

function resize() {
  canvas.width = mapEl.clientWidth;
  canvas.height = mapEl.clientHeight;
  resetView();
}
window.addEventListener('resize', resize);

function toScreen(proj) {
  return { x: proj.x * scale + offsetX, y: proj.y * scale + offsetY };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  document.getElementById('ptSizeLabel').textContent = ptSizeVal;

  projectedClusters.forEach(c => {
    const alpha = highlightCluster === -1 || highlightCluster === c.id ? 1 : 0.15;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = c.colour;

    c.points.forEach(p => {
      const s = toScreen(p.proj);
      ctx.beginPath();
      ctx.arc(s.x, s.y, ptSizeVal, 0, Math.PI * 2);
      ctx.fill();
    });

    if (showCentroids) {
      const s = toScreen(c.centroidProj);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.fillStyle = c.colour;
      ctx.beginPath();
      ctx.arc(s.x, s.y, ptSizeVal + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  });

  ctx.globalAlpha = 1;
}

function buildLegend() {
  const container = document.getElementById('legend-items');
  projectedClusters.forEach(c => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = \`<div class="legend-dot" style="background:\${c.colour}"></div> Cluster \${c.id + 1} (\${c.size})\`;
    item.addEventListener('mouseenter', () => { highlightCluster = c.id; draw(); });
    item.addEventListener('mouseleave', () => { highlightCluster = -1; draw(); });
    container.appendChild(item);
  });
}

let dragging = false, dragStart = { x: 0, y: 0 }, dragOffset = { x: 0, y: 0 };

canvas.addEventListener('mousedown', e => {
  dragging = true;
  dragStart = { x: e.clientX, y: e.clientY };
  dragOffset = { x: offsetX, y: offsetY };
  mapEl.classList.add('dragging');
});
window.addEventListener('mouseup', () => { dragging = false; mapEl.classList.remove('dragging'); });
canvas.addEventListener('mousemove', e => {
  if (dragging) {
    offsetX = dragOffset.x + (e.clientX - dragStart.x);
    offsetY = dragOffset.y + (e.clientY - dragStart.y);
    draw();
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  let found = null;
  let foundDist = 12;
  for (const c of projectedClusters) {
    for (const p of c.points) {
      const s = toScreen(p.proj);
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < foundDist) { foundDist = d; found = { p, c }; }
    }
  }
  if (found) {
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top  = (e.clientY + 12) + 'px';
    tooltip.innerHTML = \`
      <strong>\${found.p.name || found.p.id}</strong><br>
      Cluster \${found.c.id + 1}<br>
      \${found.p.lat.toFixed(5)}, \${found.p.lng.toFixed(5)}
    \`;
  } else {
    tooltip.style.display = 'none';
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  offsetX = mx - (mx - offsetX) * factor;
  offsetY = my - (my - offsetY) * factor;
  scale *= factor;
  draw();
}, { passive: false });

let lastPinchDist = 0;
canvas.addEventListener('touchstart', e => {
  if (e.touches.length === 2) lastPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
});
canvas.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const factor = d / lastPinchDist;
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const rect = canvas.getBoundingClientRect();
    const mx = cx - rect.left, my = cy - rect.top;
    offsetX = mx - (mx - offsetX) * factor;
    offsetY = my - (my - offsetY) * factor;
    scale *= factor;
    lastPinchDist = d;
    draw();
  }
});

buildLegend();
resize();
</script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`\nVisualisation written to: ${outputPath}`);
}

// ── Data loaders ─────────────────────────────────────────────────────────────

function generateSampleLocations(n: number): GeoLocation[] {
  const hubs = [
    { lat: 51.5, lng: -0.1 }, // London
    { lat: 53.5, lng: -2.2 }, // Manchester
    { lat: 53.8, lng: -1.5 }, // Leeds
    { lat: 52.5, lng: -1.9 }, // Birmingham
    { lat: 55.9, lng: -3.2 }, // Edinburgh
    { lat: 51.5, lng: -3.2 }, // Cardiff
    { lat: 54.0, lng: -1.6 }, // York
    { lat: 50.8, lng: -1.1 }, // Southampton
    { lat: 53.4, lng: -3.0 }, // Liverpool
    { lat: 52.6, lng: 1.3 }, // Norwich
    { lat: 51.9, lng: -2.1 }, // Gloucester
    { lat: 54.6, lng: -5.9 }, // Belfast
  ];

  return Array.from({ length: n }, (_, i) => {
    const hub = hubs[i % hubs.length];
    const spread = 1.5;
    return {
      id: `loc-${i + 1}`,
      lat: hub.lat + (Math.random() - 0.5) * spread,
      lng: hub.lng + (Math.random() - 0.5) * spread * 1.5,
      name: `Location ${i + 1}`,
    };
  });
}

function loadLocations(): GeoLocation[] {
  const json = JSON.parse(fs.readFileSync('./locations.json', 'utf-8'));
  return (json.companyLocations as any[]).map<GeoLocation>((e) => ({
    lat: e.location.lat,
    lng: e.location.lng,
    id: e._key,
    name: e._key,
  }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const TARGET_CLUSTER_SIZE = 100;

  const locations = loadLocations();
  // const locations = generateSampleLocations(3000);

  console.log(
    `Clustering ${locations.length} points into clusters of ~${TARGET_CLUSTER_SIZE}...`,
  );

  const start = performance.now();

  const clusters = clusterLocations(locations, TARGET_CLUSTER_SIZE);

  const end = performance.now();
  console.log(end - start, locations.length);

  printStats(clusters);
  analyseRadius(clusters, 10, 10);

  const jsonOut = path.join(__dirname, 'clusters.json');
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      clusters.map((c) => ({
        id: c.id,
        centroid: c.centroid,
        size: c.points.length,
        points: c.points,
      })),
      null,
      2,
    ),
  );
  console.log(`Cluster data written to: ${jsonOut}`);

  generateHTML(clusters, path.join(__dirname, 'clusters.html'));
}

main();
