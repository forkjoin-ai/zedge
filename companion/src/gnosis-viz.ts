/**
 * Gnosis Topology Visualization
 *
 * Serves a standalone three.js visualization page for Gnosis topology graphs.
 * Connects to the companion SSE endpoint for live updates.
 */

export default function serveGnosisViz(url: URL): Response {
  const filePath = url.searchParams.get('file') ?? '';
  const html = buildVisualizationHtml(filePath);
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

function buildVisualizationHtml(filePath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Interactive Gnosis topology graph visualization with live companion updates." />
  <title>Gnosis Topology — ${escapeHtml(filePath || 'Visualization')}</title>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.171.0/examples/jsm/"
    }
  }
  </script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0f;
      color: #e0e0e8;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      overflow: hidden;
    }
    #canvas-container {
      position: fixed;
      inset: 0;
    }
    #hud {
      position: fixed;
      top: 16px;
      left: 16px;
      padding: 12px 16px;
      background: rgba(10, 10, 15, 0.85);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.6;
      z-index: 10;
      backdrop-filter: blur(8px);
      min-width: 200px;
    }
    #hud h3 {
      color: #3b82f6;
      margin-bottom: 8px;
      font-size: 13px;
    }
    #hud .metric {
      display: flex;
      justify-content: space-between;
      gap: 16px;
    }
    #hud .metric .label { color: #8888a0; }
    #hud .metric .value { color: #e0e0e8; font-weight: 600; }
    #hud .regime-laminar { color: #60a5fa; }
    #hud .regime-transitional { color: #fbbf24; }
    #hud .regime-turbulent { color: #ef4444; }
    #tooltip {
      position: fixed;
      display: none;
      padding: 8px 12px;
      background: rgba(10, 10, 15, 0.92);
      border: 1px solid rgba(59, 130, 246, 0.4);
      border-radius: 6px;
      font-size: 11px;
      z-index: 20;
      pointer-events: none;
      backdrop-filter: blur(8px);
    }
    #status {
      position: fixed;
      bottom: 16px;
      left: 16px;
      font-size: 11px;
      color: #555;
      z-index: 10;
    }
    #file-input {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 10;
    }
    #file-input textarea {
      width: 320px;
      height: 200px;
      background: rgba(10, 10, 15, 0.85);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 8px;
      color: #e0e0e8;
      font-family: inherit;
      font-size: 11px;
      padding: 8px;
      resize: vertical;
      backdrop-filter: blur(8px);
    }
    #file-input button {
      display: block;
      margin-top: 8px;
      padding: 6px 16px;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }
    #file-input button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div id="canvas-container"></div>
  <div id="hud">
    <h3>Gnosis Topology</h3>
    <div class="metric"><span class="label">Buley</span><span class="value" id="m-buley">—</span></div>
    <div class="metric"><span class="label">Wallace</span><span class="value" id="m-wallace">—</span></div>
    <div class="metric"><span class="label">Regime</span><span class="value" id="m-regime">—</span></div>
    <div class="metric"><span class="label">Beta-1</span><span class="value" id="m-beta1">—</span></div>
    <div class="metric"><span class="label">Q-Index</span><span class="value" id="m-qindex">—</span></div>
    <div class="metric"><span class="label">Nodes</span><span class="value" id="m-nodes">—</span></div>
    <div class="metric"><span class="label">Edges</span><span class="value" id="m-edges">—</span></div>
  </div>
  <div id="tooltip"></div>
  <div id="status">Waiting for topology data...</div>
  <div id="file-input">
    <textarea id="source-text" placeholder="Paste TypeScript source here..."></textarea>
    <button id="analyze-btn">Analyze</button>
  </div>

  <script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

    const container = document.getElementById('canvas-container');
    const tooltip = document.getElementById('tooltip');

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);
    scene.fog = new THREE.FogExp2(0x0a0a0f, 0.03);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 5, 15);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambient = new THREE.AmbientLight(0x404060, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(5, 10, 5);
    scene.add(directional);

    // Node colors by kind
    const NODE_COLORS = {
      entry: 0x22c55e,   // green
      call: 0x3b82f6,    // blue
      assign: 0x06b6d4,  // cyan
      return: 0xf97316,  // orange
      join: 0xa855f7,    // purple
    };

    // Edge colors by type
    const EDGE_COLORS = {
      FORK: 0xef4444,       // red
      RACE: 0xfbbf24,       // yellow
      FOLD: 0x22c55e,       // green
      PROCESS: 0x3b82f6,    // blue
      VENT: 0x6b7280,       // gray
      INTERFERE: 0xec4899,  // magenta
    };

    const nodeGroup = new THREE.Group();
    const edgeGroup = new THREE.Group();
    const labelGroup = new THREE.Group();
    scene.add(nodeGroup);
    scene.add(edgeGroup);
    scene.add(labelGroup);

    let nodeMeshes = [];
    let nodeDataMap = new Map();

    function clearScene() {
      while (nodeGroup.children.length > 0) nodeGroup.remove(nodeGroup.children[0]);
      while (edgeGroup.children.length > 0) edgeGroup.remove(edgeGroup.children[0]);
      while (labelGroup.children.length > 0) {
        const child = labelGroup.children[0];
        if (child.element) child.element.remove();
        labelGroup.remove(child);
      }
      nodeMeshes = [];
      nodeDataMap.clear();
    }

    function renderTopology(data) {
      clearScene();
      const { nodes, edges, metrics } = data;

      // Update HUD
      if (metrics) {
        document.getElementById('m-buley').textContent = metrics.buleyNumber ?? '—';
        document.getElementById('m-wallace').textContent = metrics.wallaceNumber ?? '—';
        const regimeEl = document.getElementById('m-regime');
        regimeEl.textContent = metrics.regime ?? '—';
        regimeEl.className = 'value regime-' + (metrics.regime ?? 'laminar');
        document.getElementById('m-beta1').textContent = metrics.beta1 ?? '—';
        document.getElementById('m-qindex').textContent = metrics.quantumIndex ?? '—';
        document.getElementById('m-nodes').textContent = metrics.nodeCount ?? nodes.length;
        document.getElementById('m-edges').textContent = metrics.edgeCount ?? edges.length;

        // Ambient color by regime
        const regimeColors = { laminar: 0x1e3a5f, transitional: 0x3a3520, turbulent: 0x3a1520 };
        scene.background = new THREE.Color(regimeColors[metrics.regime] ?? 0x0a0a0f);
      }

      const nodePositions = new Map();

      // Create nodes
      for (const node of nodes) {
        const color = NODE_COLORS[node.kind] ?? 0x888888;
        const geometry = new THREE.SphereGeometry(0.3, 32, 32);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.3,
          metalness: 0.4,
          roughness: 0.6,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(node.x, node.y, 0);
        nodeGroup.add(mesh);
        nodeMeshes.push(mesh);
        nodeDataMap.set(mesh, node);
        nodePositions.set(node.id, new THREE.Vector3(node.x, node.y, 0));

        // Label
        const labelDiv = document.createElement('div');
        labelDiv.style.cssText = 'color: #e0e0e8; font-size: 10px; padding: 2px 4px; background: rgba(0,0,0,0.5); border-radius: 3px;';
        labelDiv.textContent = node.label;
        const labelObj = new CSS2DObject(labelDiv);
        labelObj.position.set(node.x, node.y + 0.5, 0);
        labelGroup.add(labelObj);
      }

      // Create edges
      for (const edge of edges) {
        const from = nodePositions.get(edge.from);
        const to = nodePositions.get(edge.to);
        if (!from || !to) continue;

        const color = EDGE_COLORS[edge.type] ?? 0x555555;
        const points = [from, to];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color, opacity: 0.7, transparent: true });
        const line = new THREE.Line(geometry, material);
        edgeGroup.add(line);
      }

      document.getElementById('status').textContent = 'Topology loaded — ' + nodes.length + ' nodes, ' + edges.length + ' edges';
    }

    // Raycasting for hover
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    renderer.domElement.addEventListener('mousemove', (event) => {
      mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(nodeMeshes);

      if (intersects.length > 0) {
        const node = nodeDataMap.get(intersects[0].object);
        if (node) {
          tooltip.style.display = 'block';
          tooltip.style.left = (event.clientX + 12) + 'px';
          tooltip.style.top = (event.clientY + 12) + 'px';
          let html = '<strong>' + node.id + '</strong> (' + node.kind + ')';
          if (node.sourceLocation) {
            html += '<br/>Line ' + node.sourceLocation.line + ':' + node.sourceLocation.column;
          }
          tooltip.innerHTML = html;
        }
      } else {
        tooltip.style.display = 'none';
      }
    });

    // Click to navigate
    renderer.domElement.addEventListener('click', () => {
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(nodeMeshes);
      if (intersects.length > 0) {
        const node = nodeDataMap.get(intersects[0].object);
        if (node && node.sourceLocation) {
          console.log('[gnosis-viz] Navigate to:', node.sourceLocation);
        }
      }
    });

    // Analyze button
    document.getElementById('analyze-btn').addEventListener('click', async () => {
      const sourceText = document.getElementById('source-text').value;
      if (!sourceText.trim()) return;

      document.getElementById('status').textContent = 'Analyzing...';
      try {
        const response = await fetch('/gnosis/topology-graph', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceText, filePath: 'editor.ts' }),
        });
        const data = await response.json();
        renderTopology(data);
      } catch (err) {
        document.getElementById('status').textContent = 'Error: ' + err.message;
      }
    });

    // SSE for live updates
    const evtSource = new EventSource('/gnosis/viz/events');
    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'topology-update') {
          renderTopology(data);
        }
      } catch {}
    };

    // Load initial file if specified
    const filePath = ${JSON.stringify(filePath)};
    if (filePath) {
      document.getElementById('status').textContent = 'Loading ' + filePath + '...';
    }

    // Animation loop
    function animate() {
      requestAnimationFrame(animate);
      controls.update();

      // Gentle node pulsing
      const t = Date.now() * 0.001;
      for (const mesh of nodeMeshes) {
        const scale = 1 + Math.sin(t * 2 + mesh.position.x) * 0.05;
        mesh.scale.setScalar(scale);
      }

      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }
    animate();

    // Resize handling
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      labelRenderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
