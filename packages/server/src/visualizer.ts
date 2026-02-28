export function getVisualizerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veil — Behavior Graph Visualizer</title>
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body {
  background: #0d1117; color: #c9d1d9;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  display: flex; flex-direction: column;
}

/* ── Toolbar ── */
#toolbar {
  height: 48px; background: #161b22;
  border-bottom: 1px solid #30363d;
  display: flex; align-items: center;
  padding: 0 16px; gap: 12px; flex-shrink: 0;
}
.logo { font-weight: 700; font-size: 16px; color: #58a6ff; white-space: nowrap; }
#url-input {
  flex: 1; max-width: 520px; height: 32px;
  background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
  color: #c9d1d9; padding: 0 12px; font-size: 14px; outline: none;
}
#url-input:focus { border-color: #58a6ff; }
#url-input::placeholder { color: #484f58; }
#decompose-btn {
  height: 32px; background: #238636; color: #fff; border: none; border-radius: 6px;
  padding: 0 16px; font-size: 14px; font-weight: 600; cursor: pointer;
}
#decompose-btn:hover { background: #2ea043; }
#decompose-btn:disabled { opacity: 0.5; cursor: default; }
#page-info { font-size: 12px; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Main layout ── */
#main { flex: 1; display: flex; overflow: hidden; }
#graph-container { flex: 1; overflow: hidden; position: relative; }
#graph-svg { width: 100%; height: 100%; }

/* ── Tree ── */
.tree-link { fill: none; stroke: #30363d; stroke-width: 1.5; }
.node rect { stroke-width: 1.5; cursor: pointer; }
.node text {
  fill: #c9d1d9; font-size: 11px; pointer-events: none;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}
.node:hover rect { filter: brightness(1.3); }
.node.selected rect { stroke: #f0f6fc !important; stroke-width: 2.5; }

/* ── Trigger arcs ── */
.trigger-arc { fill: none; stroke-width: 1.5; stroke-dasharray: 6 3; opacity: 0.5; }
.endpoint-badge text {
  font-size: 10px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
}

/* ── Detail panel ── */
#detail-panel {
  width: 360px; background: #161b22;
  border-left: 1px solid #30363d;
  overflow-y: auto; flex-shrink: 0;
  display: flex; flex-direction: column;
}
.panel-header {
  padding: 12px 16px; font-weight: 600; font-size: 14px;
  border-bottom: 1px solid #30363d; color: #f0f6fc; flex-shrink: 0;
}
#detail-content { padding: 16px; font-size: 13px; line-height: 1.6; }
.detail-section { margin-bottom: 16px; }
.detail-section h4 {
  color: #8b949e; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.5px; margin-bottom: 6px;
}
.detail-row { display: flex; justify-content: space-between; padding: 3px 0; gap: 8px; }
.detail-key { color: #8b949e; flex-shrink: 0; }
.detail-val { color: #c9d1d9; text-align: right; word-break: break-all; }
.detail-badge {
  display: inline-block; padding: 2px 8px; border-radius: 12px;
  font-size: 12px; font-weight: 500;
}
.event-item {
  padding: 4px 8px; background: #0d1117; border-radius: 4px;
  margin-bottom: 4px; font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

/* ── Status bar ── */
#status-bar {
  height: 28px; background: #161b22;
  border-top: 1px solid #30363d;
  display: flex; align-items: center;
  padding: 0 16px; gap: 20px; font-size: 12px; flex-shrink: 0;
}
#conn-status { white-space: nowrap; }
.connected { color: #3fb950; }
.disconnected { color: #f85149; }
.connecting { color: #d29922; }
#stats { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Diff animations ── */
@keyframes pulse-green {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.8) drop-shadow(0 0 8px #3fb950); }
}
@keyframes flash-yellow {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.5) drop-shadow(0 0 6px #d29922); }
}
@keyframes fade-out { from { opacity: 1; } to { opacity: 0; } }
.node-added rect { animation: pulse-green 800ms ease-out; }
.node-removed { animation: fade-out 500ms ease-out forwards; }
.node-modified rect { animation: flash-yellow 600ms ease-out; }

/* ── Placeholder ── */
.placeholder {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: #484f58; font-size: 15px; text-align: center; padding: 24px;
}

/* ── Interact buttons ── */
.interact-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.interact-btn {
  height: 28px; border: 1px solid #30363d; border-radius: 6px;
  background: #21262d; color: #c9d1d9; font-size: 12px; font-weight: 500;
  padding: 0 12px; cursor: pointer; transition: background 0.15s, border-color 0.15s;
}
.interact-btn:hover { background: #30363d; border-color: #8b949e; }
.interact-btn:disabled { opacity: 0.4; cursor: default; }
.interact-btn.act-click { border-color: #58a6ff; color: #58a6ff; }
.interact-btn.act-click:hover { background: #58a6ff22; }
.interact-btn.act-type { border-color: #3fb950; color: #3fb950; }
.interact-btn.act-type:hover { background: #3fb95022; }
.interact-btn.act-clear { border-color: #f0883e; color: #f0883e; }
.interact-btn.act-clear:hover { background: #f0883e22; }
.interact-btn.act-select { border-color: #d2a8ff; color: #d2a8ff; }
.interact-btn.act-select:hover { background: #d2a8ff22; }
.interact-type-row { display: flex; gap: 6px; width: 100%; }
.interact-input {
  flex: 1; height: 28px; background: #0d1117; border: 1px solid #30363d;
  border-radius: 6px; color: #c9d1d9; padding: 0 8px; font-size: 12px; outline: none;
  font-family: inherit;
}
.interact-input:focus { border-color: #3fb950; }
#interact-feedback { font-size: 11px; margin-top: 6px; min-height: 16px; }
.feedback-ok { color: #3fb950; }
.feedback-err { color: #f85149; }
.feedback-loading { color: #d29922; }
</style>
</head>
<body>

<div id="toolbar">
  <span class="logo">&cir; Veil</span>
  <input id="url-input" placeholder="Enter URL to decompose..." spellcheck="false" />
  <button id="decompose-btn">Decompose</button>
  <span id="page-info"></span>
</div>

<div id="main">
  <div id="graph-container">
    <svg id="graph-svg"></svg>
  </div>
  <div id="detail-panel">
    <div class="panel-header">Node Detail</div>
    <div id="detail-content"><div class="placeholder">Enter a URL and click Decompose</div></div>
  </div>
</div>

<div id="status-bar">
  <span id="conn-status" class="disconnected">&cir; Ready</span>
  <span id="stats"></span>
</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
(function () {
'use strict';

// ── Constants ──
var ROLE_COLORS = {
  button: '#58a6ff', textbox: '#3fb950', link: '#bc8cff',
  checkbox: '#f0883e', radio: '#f0883e', 'switch': '#f0883e',
  navigation: '#79c0ff', nav: '#79c0ff', banner: '#79c0ff',
  form: '#d2a8ff', dialog: '#ffa657', alertdialog: '#ffa657',
  heading: '#79c0ff', img: '#d2a8ff', image: '#d2a8ff',
  list: '#6e7681', listitem: '#6e7681', menu: '#79c0ff',
  menuitem: '#79c0ff', tab: '#58a6ff', tablist: '#58a6ff',
  search: '#3fb950', WebArea: '#58a6ff', main: '#79c0ff',
  region: '#79c0ff', complementary: '#79c0ff',
};
var DEFAULT_NODE_COLOR = '#8b949e';
var METHOD_COLORS = { GET: '#3fb950', POST: '#58a6ff', PUT: '#f0883e', DELETE: '#f85149', PATCH: '#d2a8ff' };

function getRoleColor(role) { return ROLE_COLORS[role] || DEFAULT_NODE_COLOR; }

// ── State ──
var sessionId = null;
var ws = null;
var heartbeatTimer = null;
var currentParsed = null;
var currentVersion = 0;
var selectedNodeId = null;

// ── DOM refs ──
var urlInput = document.getElementById('url-input');
var decomposeBtn = document.getElementById('decompose-btn');
var pageInfo = document.getElementById('page-info');
var graphContainer = document.getElementById('graph-container');
var detailContent = document.getElementById('detail-content');
var connStatus = document.getElementById('conn-status');
var statsEl = document.getElementById('stats');

// ── SVG setup ──
var svg = d3.select('#graph-svg');
var zoomGroup = svg.append('g').attr('class', 'zoom-group');
var linksGroup = zoomGroup.append('g').attr('class', 'links-group');
var nodesGroup = zoomGroup.append('g').attr('class', 'nodes-group');
var arcsGroup = zoomGroup.append('g').attr('class', 'arcs-group');

var zoomBehavior = d3.zoom()
  .scaleExtent([0.1, 4])
  .on('zoom', function (e) { zoomGroup.attr('transform', e.transform); });
svg.call(zoomBehavior);

// ── Helpers ──
function esc(s) {
  var d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}
function truncLabel(s, max) { return s.length > max ? s.slice(0, max - 1) + '\\u2026' : s; }
function shortUrl(url) {
  try { var u = new URL(url); var p = u.pathname; return p.length > 40 ? p.slice(0, 37) + '...' : p; }
  catch (_) { return url ? url.slice(0, 40) : ''; }
}

// ── Session ──
function startSession(url) {
  if (!/^https?:\\/\\//.test(url)) url = 'https://' + url;
  urlInput.value = url;
  decomposeBtn.disabled = true;
  decomposeBtn.textContent = 'Loading\\u2026';
  setStatus('connecting', 'Connecting\\u2026');

  disconnect();
  fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url }),
  })
  .then(function (resp) {
    if (!resp.ok) return resp.json().then(function (e) { throw new Error(e.error ? e.error.message : 'HTTP ' + resp.status); });
    return resp.json();
  })
  .then(function (data) {
    sessionId = data.id;
    connectWebSocket(sessionId);
  })
  .catch(function (err) {
    setStatus('disconnected', 'Error: ' + err.message);
    decomposeBtn.disabled = false;
    decomposeBtn.textContent = 'Decompose';
  });
}

// ── WebSocket ──
function connectWebSocket(id) {
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws/sessions/' + id + '/graph');

  ws.onopen = function () {
    setStatus('connected', 'Connected');
    decomposeBtn.disabled = false;
    decomposeBtn.textContent = 'Decompose';
    heartbeatTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
  };

  ws.onmessage = function (evt) {
    try {
      var msg = JSON.parse(evt.data);
      if (msg.type === 'snapshot') handleSnapshot(msg);
      else if (msg.type === 'diff') handleDiff(msg);
      else if (msg.type === 'error') {
        console.error('WS error:', msg.error);
        setStatus('disconnected', 'Error: ' + msg.error.message);
      }
    } catch (e) { console.error('WS parse error:', e); }
  };

  ws.onclose = function () {
    setStatus('disconnected', 'Disconnected');
    clearInterval(heartbeatTimer);
    ws = null;
  };
  ws.onerror = function () { setStatus('disconnected', 'Connection error'); };
}

function disconnect() {
  if (ws) { ws.close(); ws = null; }
  clearInterval(heartbeatTimer);
  sessionId = null;
  currentParsed = null;
  currentVersion = 0;
}

// ── Message handlers ──
function handleSnapshot(msg) {
  currentVersion = msg.version;
  currentParsed = parseGraph(msg.graph);
  renderTree(currentParsed);
  renderTriggerArcs(currentParsed);
  updateStats(currentParsed);
  fitToView();
}

function handleDiff(msg) {
  currentVersion = msg.version;
  currentParsed = parseGraph(msg.graph);
  var diffOpts = {
    added: new Set(msg.diff.added || []),
    removed: new Set(msg.diff.removed || []),
    modified: new Set(msg.diff.modified || []),
  };
  renderTree(currentParsed, diffOpts);
  renderTriggerArcs(currentParsed);
  updateStats(currentParsed);
}

// ── Graph parsing ──
function makeDisplayId(nodeId, meta) {
  var raw = (meta.name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return raw ? (meta.role + '-' + raw) : (meta.role + '-' + nodeId.slice(0, 8));
}

function buildDisplayIds(nodes) {
  var map = new Map();
  var used = new Set();
  Object.keys(nodes).forEach(function (id) {
    var meta = nodes[id].metadata || {};
    var did = makeDisplayId(id, meta);
    if (used.has(did)) { var i = 2; while (used.has(did + '-' + i)) i++; did = did + '-' + i; }
    used.add(did);
    map.set(id, did);
  });
  return map;
}

function parseGraph(jgf) {
  var g = jgf.graph || jgf;
  var nodes = g.nodes || {};
  var edges = g.edges || [];

  var containsEdges = [], triggerEdges = [];
  edges.forEach(function (e) {
    if (e.relation === 'contains') containsEdges.push(e);
    else if (e.relation === 'triggers') triggerEdges.push(e);
  });

  var childrenOf = {};
  var hasParent = new Set();
  containsEdges.forEach(function (e) {
    if (!childrenOf[e.source]) childrenOf[e.source] = [];
    childrenOf[e.source].push(e.target);
    hasParent.add(e.target);
  });

  var allNodeIds = Object.keys(nodes);
  var roots = allNodeIds.filter(function (id) { return !hasParent.has(id); });
  var displayIds = buildDisplayIds(nodes);

  function buildNode(nodeId, visited) {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    var children = (childrenOf[nodeId] || [])
      .map(function (cid) { return nodes[cid] ? buildNode(cid, visited) : null; })
      .filter(Boolean);
    return {
      id: nodeId,
      displayId: displayIds.get(nodeId) || nodeId,
      nodeData: nodes[nodeId],
      children: children.length > 0 ? children : undefined,
    };
  }

  var treeRoot;
  if (roots.length === 0) {
    treeRoot = { id: '__empty__', displayId: 'empty', nodeData: null };
  } else if (roots.length === 1) {
    treeRoot = buildNode(roots[0], new Set());
  } else {
    treeRoot = {
      id: '__root__', displayId: 'page',
      nodeData: { label: 'Page', metadata: { role: 'WebArea', name: '' } },
      children: roots.map(function (id) { return buildNode(id, new Set()); }).filter(Boolean),
    };
  }

  return {
    tree: treeRoot,
    triggers: triggerEdges,
    metadata: g.metadata || {},
    version: g.version || 0,
    apiEndpoints: g.apiEndpoints || [],
    componentGroups: g.componentGroups || [],
    nodes: nodes,
    displayIds: displayIds,
  };
}

// ── Rendering ──
var linkGen = d3.linkVertical().x(function (d) { return d.x; }).y(function (d) { return d.y; });

function renderTree(parsed, diffOpts) {
  if (!parsed || !parsed.tree) return;

  var hierarchy = d3.hierarchy(parsed.tree, function (d) { return d.children; });
  d3.tree().nodeSize([170, 90])(hierarchy);

  var allNodes = hierarchy.descendants();
  var allLinks = hierarchy.links();

  // ─ Links ─
  var linkSel = linksGroup.selectAll('path.tree-link')
    .data(allLinks, function (d) { return d.source.data.id + '>' + d.target.data.id; });

  linkSel.enter().append('path').attr('class', 'tree-link')
    .attr('d', linkGen).attr('opacity', 0)
    .transition().duration(400).attr('opacity', 1);

  linkSel.transition().duration(500).attr('d', linkGen);
  linkSel.exit().transition().duration(300).attr('opacity', 0).remove();

  // ─ Nodes ─
  var nodeSel = nodesGroup.selectAll('g.node')
    .data(allNodes, function (d) { return d.data.id; });

  var nodeEnter = nodeSel.enter().append('g').attr('class', 'node')
    .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; })
    .style('opacity', 0)
    .on('click', function (evt, d) { evt.stopPropagation(); selectNode(d.data.id); });

  nodeEnter.append('rect').attr('rx', 6).attr('ry', 6)
    .attr('x', -72).attr('y', -18).attr('width', 144).attr('height', 36)
    .attr('fill', function (d) { return getRoleColor(d.data.nodeData?.metadata?.role); })
    .attr('fill-opacity', 0.15)
    .attr('stroke', function (d) { return getRoleColor(d.data.nodeData?.metadata?.role); });

  nodeEnter.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
    .text(function (d) { return truncLabel(d.data.displayId, 18); });

  nodeEnter.transition().duration(400).style('opacity', 1);

  // Update
  var nodeUpdate = nodeEnter.merge(nodeSel);
  nodeUpdate.transition().duration(500)
    .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; })
    .style('opacity', 1);

  nodeUpdate.select('rect')
    .attr('fill', function (d) { return getRoleColor(d.data.nodeData?.metadata?.role); })
    .attr('stroke', function (d) { return getRoleColor(d.data.nodeData?.metadata?.role); });
  nodeUpdate.select('text')
    .text(function (d) { return truncLabel(d.data.displayId, 18); });
  nodeUpdate.classed('selected', function (d) { return d.data.id === selectedNodeId; });

  // Exit
  nodeSel.exit().classed('node-removed', true)
    .transition().duration(500).style('opacity', 0).remove();

  // Diff classes
  if (diffOpts) {
    nodeUpdate.each(function (d) {
      var el = d3.select(this);
      if (diffOpts.added.has(d.data.id)) el.classed('node-added', true);
      if (diffOpts.modified.has(d.data.id)) el.classed('node-modified', true);
    });
    setTimeout(function () {
      nodesGroup.selectAll('.node-added').classed('node-added', false);
      nodesGroup.selectAll('.node-modified').classed('node-modified', false);
    }, 1200);
  }
}

function renderTriggerArcs(parsed) {
  var triggers = parsed.triggers;
  if (!triggers || !triggers.length) { arcsGroup.selectAll('*').remove(); return; }

  // Collect node positions from rendered tree
  var nodePos = {};
  nodesGroup.selectAll('g.node').each(function (d) { nodePos[d.data.id] = { x: d.x, y: d.y }; });

  // Deduplicate endpoints by method + pattern
  var epMap = new Map();
  var epList = [];
  triggers.forEach(function (t) {
    var meta = t.metadata || {};
    var method = (meta.request && meta.request.method) || 'GET';
    var pattern = meta.urlPattern || shortUrl((meta.request && meta.request.url) || t.target);
    var key = method + ' ' + pattern;
    if (!epMap.has(key)) {
      var ep = { method: method, pattern: pattern, key: key, sources: [] };
      epMap.set(key, ep);
      epList.push(ep);
    }
    epMap.get(key).sources.push(t.source);
  });

  // Position endpoints to the right of the tree
  var maxX = 0;
  Object.values(nodePos).forEach(function (p) { if (p.x > maxX) maxX = p.x; });
  var epX = maxX + 240;
  var epStartY = -((epList.length - 1) * 28) / 2;
  epList.forEach(function (ep, i) { ep.x = epX; ep.y = epStartY + i * 28; });

  // Endpoint badges
  var badgeSel = arcsGroup.selectAll('g.endpoint-badge').data(epList, function (d) { return d.key; });

  var badgeEnter = badgeSel.enter().append('g').attr('class', 'endpoint-badge')
    .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });

  badgeEnter.append('rect').attr('x', -4).attr('y', -10).attr('height', 20).attr('rx', 4).attr('ry', 4)
    .attr('fill', function (d) { return (METHOD_COLORS[d.method] || '#8b949e'); })
    .attr('fill-opacity', 0.12)
    .attr('stroke', function (d) { return (METHOD_COLORS[d.method] || '#8b949e'); })
    .attr('stroke-opacity', 0.4);

  badgeEnter.append('text').attr('dy', '0.35em')
    .attr('fill', function (d) { return (METHOD_COLORS[d.method] || '#8b949e'); })
    .text(function (d) { return truncLabel(d.key, 42); });

  badgeEnter.each(function () {
    var g = d3.select(this);
    var bbox = g.select('text').node().getBBox();
    g.select('rect').attr('width', bbox.width + 12);
  });

  badgeEnter.merge(badgeSel)
    .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
  badgeSel.exit().remove();

  // Arcs from source nodes to endpoint badges
  var arcData = [];
  epList.forEach(function (ep) {
    ep.sources.forEach(function (src) {
      var pos = nodePos[src];
      if (pos) arcData.push({ sx: pos.x, sy: pos.y, ep: ep, key: src + '>' + ep.key });
    });
  });

  var arcSel = arcsGroup.selectAll('path.trigger-arc').data(arcData, function (d) { return d.key; });

  arcSel.enter().append('path').attr('class', 'trigger-arc')
    .attr('stroke', function (d) { return METHOD_COLORS[d.ep.method] || '#8b949e'; })
    .merge(arcSel)
    .attr('d', function (d) {
      var sx = d.sx + 72, sy = d.sy;
      var tx = d.ep.x - 4, ty = d.ep.y;
      var mx = (sx + tx) / 2;
      return 'M' + sx + ',' + sy + ' C' + mx + ',' + sy + ' ' + mx + ',' + ty + ' ' + tx + ',' + ty;
    });

  arcSel.exit().remove();
}

// ── Node detail ──
function selectNode(nodeId) {
  selectedNodeId = nodeId;
  nodesGroup.selectAll('g.node').classed('selected', function (d) { return d.data.id === nodeId; });
  showNodeDetail(nodeId, currentParsed);
}

function showNodeDetail(nodeId, parsed) {
  var node = parsed.nodes[nodeId];
  if (!node) { detailContent.innerHTML = '<div class="placeholder">Node not found</div>'; return; }

  var meta = node.metadata || {};
  var displayId = parsed.displayIds.get(nodeId) || nodeId;
  var roleColor = getRoleColor(meta.role);
  var h = '';

  // Identity
  h += '<div class="detail-section"><h4>Identity</h4>';
  h += '<div class="detail-row"><span class="detail-key">Display ID</span><span class="detail-val" style="font-family:monospace">' + esc(displayId) + '</span></div>';
  h += '<div class="detail-row"><span class="detail-key">Role</span><span class="detail-badge" style="background:' + roleColor + '22;color:' + roleColor + '">' + esc(meta.role || '\\u2014') + '</span></div>';
  if (meta.name) h += '<div class="detail-row"><span class="detail-key">Name</span><span class="detail-val">' + esc(meta.name) + '</span></div>';
  if (meta.description) h += '<div class="detail-row"><span class="detail-key">Description</span><span class="detail-val">' + esc(meta.description) + '</span></div>';
  h += '</div>';

  // State
  if (meta.state && Object.keys(meta.state).length > 0) {
    h += '<div class="detail-section"><h4>State</h4>';
    Object.keys(meta.state).forEach(function (k) {
      h += '<div class="detail-row"><span class="detail-key">' + esc(k) + '</span><span class="detail-val">' + esc(String(meta.state[k])) + '</span></div>';
    });
    h += '</div>';
  }

  // Value
  if (meta.value) {
    h += '<div class="detail-section"><h4>Value</h4><div class="detail-val">' + esc(meta.value) + '</div></div>';
  }

  // Events
  if (meta.events && meta.events.length > 0) {
    h += '<div class="detail-section"><h4>Events</h4>';
    meta.events.forEach(function (evt) {
      var effect = evt.estimatedEffect ? ' \\u2192 ' + esc(evt.estimatedEffect) : '';
      h += '<div class="event-item">on:' + esc(evt.eventType) + ' \\u2192 ' + esc(evt.category) + effect + '</div>';
    });
    h += '</div>';
  }

  // Semantic label
  if (meta.semanticLabel) {
    var sl = meta.semanticLabel;
    h += '<div class="detail-section"><h4>Semantic</h4>';
    h += '<div class="detail-row"><span class="detail-key">Label</span><span class="detail-val">' + esc(sl.category) + ':' + esc(sl.action) + '</span></div>';
    h += '<div class="detail-row"><span class="detail-key">Confidence</span><span class="detail-val">' + (sl.confidence * 100).toFixed(0) + '%</span></div>';
    h += '<div class="detail-row"><span class="detail-key">Source</span><span class="detail-val">' + esc(sl.source) + '</span></div>';
    h += '</div>';
  }

  // Component
  if (meta.componentId) {
    var group = (parsed.componentGroups || []).find(function (g) { return g.id === meta.componentId; });
    h += '<div class="detail-section"><h4>Component</h4>';
    h += '<div class="detail-row"><span class="detail-key">ID</span><span class="detail-val" style="font-family:monospace">' + esc(meta.componentId) + '</span></div>';
    if (group) {
      h += '<div class="detail-row"><span class="detail-key">Name</span><span class="detail-val">' + esc(group.componentName) + '</span></div>';
      h += '<div class="detail-row"><span class="detail-key">Framework</span><span class="detail-val">' + esc(group.framework) + '</span></div>';
    }
    h += '</div>';
  }

  // Network edges triggered by this node
  var nodeTriggers = parsed.triggers.filter(function (t) { return t.source === nodeId; });
  if (nodeTriggers.length > 0) {
    h += '<div class="detail-section"><h4>Network</h4>';
    nodeTriggers.forEach(function (t) {
      var req = (t.metadata && t.metadata.request) || {};
      var pattern = (t.metadata && t.metadata.urlPattern) || shortUrl(req.url || t.target);
      var method = req.method || 'GET';
      var color = METHOD_COLORS[method] || '#8b949e';
      h += '<div class="event-item"><span style="color:' + color + ';font-weight:600">' + esc(method) + '</span> ' + esc(pattern) + '</div>';
      if (t.metadata && t.metadata.response) {
        var resp = t.metadata.response;
        h += '<div class="event-item" style="margin-left:12px;font-size:11px;color:#8b949e">\\u2192 ' + resp.status + ' (' + esc(resp.contentType || 'unknown') + ')</div>';
      }
    });
    h += '</div>';
  }

  // Interact buttons (only when session is active)
  if (sessionId && nodeId !== '__root__' && nodeId !== '__empty__') {
    var hasEvents = meta.events && meta.events.length > 0;
    h += buildInteractHtml(nodeId, meta.role || '', hasEvents);
  }

  detailContent.innerHTML = h;
}

// ── Stats ──
function updateStats(parsed) {
  var nodeCount = Object.keys(parsed.nodes).length;
  var apiCount = parsed.apiEndpoints.length;
  var compCount = parsed.componentGroups.length;
  statsEl.textContent = 'v' + parsed.version + '  ' + nodeCount + ' nodes  ' + apiCount + ' APIs  ' + compCount + ' components';
  var meta = parsed.metadata;
  if (meta.title || meta.url) pageInfo.textContent = meta.title ? (meta.title + ' \\u2014 ' + meta.url) : meta.url;
}

function setStatus(state, text) {
  connStatus.className = state;
  var icon = state === 'connected' ? '\\u25cf ' : state === 'connecting' ? '\\u25cc ' : '\\u25cb ';
  connStatus.textContent = icon + (text || state);
}

function fitToView() {
  setTimeout(function () {
    var bounds = zoomGroup.node().getBBox();
    if (bounds.width === 0 && bounds.height === 0) return;
    var rect = graphContainer.getBoundingClientRect();
    var pad = 50;
    var scale = Math.min(
      (rect.width - pad * 2) / bounds.width,
      (rect.height - pad * 2) / bounds.height,
      1.5
    );
    var tx = rect.width / 2 - (bounds.x + bounds.width / 2) * scale;
    var ty = pad - bounds.y * scale;
    svg.transition().duration(600)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }, 120);
}

// ── Interact ──
var CLICKABLE_ROLES = ['button','link','checkbox','radio','switch','menuitem','tab','option','treeitem','row'];
var TYPEABLE_ROLES = ['textbox','TextField','searchbox','spinbutton','combobox'];

function interactWithNode(nodeId, action) {
  if (!sessionId) return;
  var fb = document.getElementById('interact-feedback');
  if (fb) { fb.className = 'feedback-loading'; fb.textContent = 'Sending ' + action.action + '\\u2026'; }

  // Disable all interact buttons during request
  document.querySelectorAll('.interact-btn').forEach(function (b) { b.disabled = true; });

  fetch('/api/sessions/' + sessionId + '/interact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: nodeId, action: action }),
  })
  .then(function (resp) {
    if (!resp.ok) return resp.json().then(function (e) { throw new Error(e.error ? e.error.message : 'HTTP ' + resp.status); });
    return resp.json();
  })
  .then(function (data) {
    if (fb) { fb.className = 'feedback-ok'; fb.textContent = action.action + ' successful'; }
    // Render the updated graph from the interact response directly
    if (data && data.graph) {
      var prevNodes = currentParsed ? Object.keys(currentParsed.nodes) : [];
      var prevSet = {};
      prevNodes.forEach(function (id) { prevSet[id] = true; });
      currentParsed = parseGraph(data);
      currentVersion = currentParsed.version;
      var newIds = Object.keys(currentParsed.nodes);
      var diffOpts = {
        added: new Set(newIds.filter(function (id) { return !prevSet[id]; })),
        removed: new Set(prevNodes.filter(function (id) { return !currentParsed.nodes[id]; })),
        modified: new Set(newIds.filter(function (id) { return prevSet[id]; })),
      };
      renderTree(currentParsed, diffOpts);
      renderTriggerArcs(currentParsed);
      updateStats(currentParsed);
      // If selected node was removed, clear selection text (but don't rebuild panel)
      if (selectedNodeId && !currentParsed.nodes[selectedNodeId]) {
        selectedNodeId = null;
        detailContent.innerHTML = '<div class="placeholder">Node removed after interaction</div>';
      }
    }
  })
  .catch(function (err) {
    if (fb) { fb.className = 'feedback-err'; fb.textContent = err.message; }
  })
  .finally(function () {
    document.querySelectorAll('.interact-btn').forEach(function (b) { b.disabled = false; });
  });
}
// Expose for inline onclick handlers
window._veilInteract = interactWithNode;
window._veilInteractType = function (nodeId) {
  var input = document.getElementById('type-input');
  var text = input ? input.value : '';
  if (!text) { var fb = document.getElementById('interact-feedback'); if (fb) { fb.className = 'feedback-err'; fb.textContent = 'Enter text first'; } return; }
  interactWithNode(nodeId, { action: 'type', text: text });
};
window._veilInteractSelect = function (nodeId) {
  var input = document.getElementById('select-input');
  var val = input ? input.value : '';
  if (!val) { var fb = document.getElementById('interact-feedback'); if (fb) { fb.className = 'feedback-err'; fb.textContent = 'Enter value first'; } return; }
  interactWithNode(nodeId, { action: 'select', value: val });
};

function buildInteractHtml(nodeId, role, hasEvents) {
  var isClickable = CLICKABLE_ROLES.indexOf(role) !== -1 || hasEvents;
  var isTypeable = TYPEABLE_ROLES.indexOf(role) !== -1;
  var nid = esc(nodeId).replace(/'/g, "\\\\'");

  var h = '<div class="detail-section"><h4>Interact</h4>';
  h += '<div class="interact-actions">';

  if (isClickable) {
    h += '<button class="interact-btn act-click" onclick="window._veilInteract(\\'' + nid + '\\',{action:\\'click\\'})">Click</button>';
  }
  h += '<button class="interact-btn" onclick="window._veilInteract(\\'' + nid + '\\',{action:\\'focus\\'})">Focus</button>';
  h += '<button class="interact-btn" onclick="window._veilInteract(\\'' + nid + '\\',{action:\\'hover\\'})">Hover</button>';
  h += '</div>';

  if (isTypeable) {
    h += '<div class="interact-type-row" style="margin-bottom:6px">';
    h += '<input class="interact-input" id="type-input" placeholder="Text to type\\u2026" onkeydown="if(event.key===\\'Enter\\')window._veilInteractType(\\'' + nid + '\\')" />';
    h += '<button class="interact-btn act-type" onclick="window._veilInteractType(\\'' + nid + '\\')">Type</button>';
    h += '</div>';
    h += '<div class="interact-actions">';
    h += '<button class="interact-btn act-clear" onclick="window._veilInteract(\\'' + nid + '\\',{action:\\'clear\\'})">Clear</button>';
    h += '</div>';
  }

  if (role === 'listbox' || role === 'combobox') {
    h += '<div class="interact-type-row" style="margin-bottom:6px">';
    h += '<input class="interact-input" id="select-input" placeholder="Option value\\u2026" />';
    h += '<button class="interact-btn act-select" onclick="window._veilInteractSelect(\\'' + nid + '\\')">Select</button>';
    h += '</div>';
  }

  h += '<div id="interact-feedback"></div>';
  h += '</div>';
  return h;
}

// ── Init ──
(function init() {
  decomposeBtn.addEventListener('click', function () {
    var url = urlInput.value.trim();
    if (url) startSession(url);
  });
  urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') decomposeBtn.click();
  });
  svg.on('click', function () {
    selectedNodeId = null;
    nodesGroup.selectAll('g.node').classed('selected', false);
    detailContent.innerHTML = '<div class="placeholder">Click a node to inspect</div>';
  });
  urlInput.focus();
})();

})();
</script>
</body>
</html>`;
}
