import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const requestedPort = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'
const dataDirectory = join(process.cwd(), 'data')
const dataFile = join(dataDirectory, 'state.json')
const distDirectory = join(process.cwd(), 'dist')
const modelFile = join(process.cwd(), 'model.json')
let tick = 0
let alertLog = []
let forcedWave = false
let cameras = [
  { id: 'cam-east-01', name: 'East Gate camera 01', area: 'East Gate', type: 'SIMULATED', status: 'online' },
  { id: 'cam-west-01', name: 'West Lawn camera 01', area: 'West Lawn', type: 'SIMULATED', status: 'online' },
]
let teamMembers = [
  { id: 'member-organizer', name: 'Arun Raj', role: 'Organizer', phone: '+91 98765 43210', channels: ['SMS', 'WhatsApp', 'APP'], status: 'active' },
  { id: 'member-security', name: 'Meena Kumar', role: 'Security lead', phone: '+91 98765 43211', channels: ['WhatsApp', 'APP'], status: 'active' },
  { id: 'member-medical', name: 'Dr. Ravi', role: 'Medical team', phone: '+91 98765 43212', channels: ['SMS', 'APP'], status: 'active' },
]
const visionProcesses = new Map()
const visionMetrics = new Map()
const riskModel = existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : null

if (existsSync(dataFile)) {
  try {
    const saved = JSON.parse(readFileSync(dataFile, 'utf8'))
    cameras = Array.isArray(saved.cameras) ? saved.cameras : cameras
    alertLog = Array.isArray(saved.alertLog) ? saved.alertLog : alertLog
    teamMembers = Array.isArray(saved.teamMembers) ? saved.teamMembers : teamMembers
  } catch { console.warn('Could not read saved state; starting with defaults.') }
}

function persistState() {
  mkdirSync(dataDirectory, { recursive: true })
  writeFileSync(dataFile, JSON.stringify({ cameras, alertLog, teamMembers }, null, 2))
}

function predictRisk(features) {
  if (!riskModel) return { label: 'watch', score: 50, confidence: 50 }
  const normalized = [features.density / 4.5, 1 - features.movement / 1.3, features.arrivalPressure / 2.4, 1 - features.exitFlow / 1.2]
  const logits = riskModel.weights.map((weights, index) => weights.reduce((sum, weight, featureIndex) => sum + weight * normalized[featureIndex], riskModel.bias[index]))
  const peak = Math.max(...logits)
  const probabilities = logits.map((value) => Math.exp(value - peak))
  const total = probabilities.reduce((sum, value) => sum + value, 0)
  const scores = probabilities.map((value) => value / total)
  const winner = scores.indexOf(Math.max(...scores))
  return { label: riskModel.classes[winner], score: Math.round(scores[2] * 100), confidence: Math.round(scores[winner] * 100) }
}

function startVision(camera) {
  if (camera.type === 'SIMULATED' || !camera.url || visionProcesses.has(camera.id)) return
  const python = process.env.PYTHON_BIN ?? 'python3'
  const worker = spawn(python, ['vision_worker.py', '--camera-id', camera.id, '--area', camera.area, '--url', camera.url], { cwd: process.cwd() })
  visionProcesses.set(camera.id, worker)
  camera.status = 'starting_vision'
  worker.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      try {
        const metric = JSON.parse(line)
        if (metric.status === 'vision_unavailable') camera.status = 'vision_unavailable'
        else if (metric.status === 'offline') camera.status = 'offline'
        else { camera.status = 'online'; visionMetrics.set(camera.id, metric) }
      } catch { /* Ignore non-JSON worker logs. */ }
    }
  })
  worker.on('error', (error) => { camera.status = 'vision_unavailable'; camera.error = error.message })
  worker.on('exit', (code) => { visionProcesses.delete(camera.id); if (code && camera.status === 'starting_vision') camera.status = 'offline' })
}

for (const camera of cameras) startVision(camera)

function getState() {
  tick += 1
  const wave = forcedWave || tick % 6 >= 4
  const eastDensity = wave ? 3.05 + (tick % 3) * 0.08 : 2.65 + (tick % 3) * 0.04
  const eastPeople = wave ? 4820 + (tick % 4) * 75 : 4580 + (tick % 4) * 40
  const mlRisk = predictRisk({ density: eastDensity, movement: wave ? 0.52 : 0.71, arrivalPressure: wave ? 1.8 : 1.1, exitFlow: wave ? 0.55 : 0.9 })
  const riskScore = mlRisk.label === 'critical' ? Math.max(85, mlRisk.score) : mlRisk.label === 'watch' ? Math.max(55, mlRisk.score) : mlRisk.score
  const risk = mlRisk.label
  const areaMetric = (area) => {
    const camera = cameras.find((item) => item.area === area && visionMetrics.has(item.id))
    return camera ? visionMetrics.get(camera.id) : null
  }
  const eastMetric = areaMetric('East Gate')
  const westMetric = areaMetric('West Lawn')
  const northMetric = areaMetric('North Exit')
  return {
    timestamp: new Date().toISOString(),
    model: { name: riskModel?.name ?? 'MOVA Crowd Risk Model', version: riskModel?.version ?? 'unavailable', confidence: mlRisk.confidence, status: riskModel ? 'trained' : 'unavailable', method: 'density + movement + flow' },
    cameras: { connected: cameras.filter((camera) => camera.status === 'online').length, total: cameras.length, source: 'camera-registry', list: cameras.map((camera) => ({ ...camera, metric: visionMetrics.get(camera.id) ?? null })) },
    zones: [
      { id: 'east-gate', name: 'East Gate', people: eastMetric?.people ?? eastPeople, density: eastMetric?.density ?? Number(eastDensity.toFixed(2)), movement: wave ? 0.52 : 0.71, risk: eastMetric ? (eastMetric.density >= 3.5 ? 'critical' : eastMetric.density >= 2.5 ? 'watch' : 'safe') : risk },
      { id: 'west-lawn', name: 'West Lawn', people: westMetric?.people ?? 2160 + (tick % 3) * 10, density: westMetric?.density ?? 1.8, movement: 0.86, risk: 'safe' },
      { id: 'north-exit', name: 'North Exit', people: northMetric?.people ?? 680, density: northMetric?.density ?? 1.1, movement: 1.12, risk: 'safe' },
    ],
    riskScore,
    recommendation: risk === 'critical' ? 'Pause East Gate entry for 90 seconds and open the North Exit relief route.' : risk === 'watch' ? 'Slow East Gate entry and place two stewards near the North Exit.' : 'Keep entry open and continue monitoring East Gate.',
    alert: wave ? { severity: risk, title: 'East Gate density rising', message: 'CrowdFlow AI detected a compression pattern at East Gate.' } : null,
    alertsSent: alertLog,
    team: { total: teamMembers.length, active: teamMembers.filter((member) => member.status === 'active').length, members: teamMembers },
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk; if (body.length > 100_000) request.destroy(new Error('Request too large')) })
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('Invalid JSON')) }
    })
    request.on('error', reject)
  })
}

function serveStatic(response, pathname) {
  if (!existsSync(join(distDirectory, 'index.html'))) return json(response, 503, { error: 'Frontend is not built. Run npm run build.' })
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1)
  const filePath = normalize(join(distDirectory, requested))
  if (!filePath.startsWith(distDirectory) || !existsSync(filePath)) return serveFile(response, join(distDirectory, 'index.html'))
  return serveFile(response, filePath)
}

function serveFile(response, filePath) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  response.writeHead(200, { 'Content-Type': types[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
  response.end(response.req?.method === 'HEAD' ? undefined : readFileSync(filePath))
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' }); response.end(); return }
  if (pathname === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok', service: 'mova-flow', timestamp: new Date().toISOString() })
  if (pathname === '/api/state' && request.method === 'GET') return json(response, 200, getState())
  if (pathname === '/api/simulate' && request.method === 'POST') { forcedWave = true; return json(response, 200, getState()) }
  if (pathname === '/api/auth/google' && request.method === 'POST') {
    if (!process.env.GOOGLE_CLIENT_ID) return json(response, 503, { error: 'Google login is not configured.' })
    try {
      const body = await readBody(request)
      if (!body.credential) return json(response, 400, { error: 'Google credential is required.' })
      const verification = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential)}`)
      if (!verification.ok) return json(response, 401, { error: 'Google credential is invalid.' })
      const profile = await verification.json()
      if (profile.aud !== process.env.GOOGLE_CLIENT_ID || profile.email_verified !== 'true') return json(response, 401, { error: 'Google account could not be verified.' })
      return json(response, 200, { name: profile.name ?? profile.email, email: profile.email, picture: profile.picture })
    } catch { return json(response, 400, { error: 'Could not verify Google login.' }) }
  }
  if (pathname === '/api/cameras' && request.method === 'POST') {
    try {
      const body = await readBody(request)
      if (!body.name || !body.url || !body.type) return json(response, 400, { error: 'Camera name, stream type, and URL are required.' })
      const camera = { id: randomUUID(), name: body.name, area: body.area || 'Unassigned area', type: body.type, url: body.url, status: 'online' }
      cameras = [camera, ...cameras]
      startVision(camera)
      persistState()
      return json(response, 201, camera)
    } catch { return json(response, 400, { error: 'Invalid camera details.' }) }
  }
  if (pathname === '/api/team/invite' && request.method === 'POST') {
    try {
      const body = await readBody(request)
      if (!body.name || !body.role || !body.phone) return json(response, 400, { error: 'Name, role, and phone are required.' })
      const member = { id: randomUUID(), name: body.name, role: body.role, phone: body.phone, channels: body.channels ?? ['WhatsApp', 'APP'], status: 'active' }
      teamMembers = [member, ...teamMembers]
      persistState()
      return json(response, 201, member)
    } catch { return json(response, 400, { error: 'Invalid team member details.' }) }
  }
  if (pathname.startsWith('/api/team/') && request.method === 'DELETE') {
    const memberId = decodeURIComponent(pathname.replace('/api/team/', ''))
    const previousLength = teamMembers.length
    teamMembers = teamMembers.filter((member) => member.id !== memberId)
    if (teamMembers.length === previousLength) return json(response, 404, { error: 'Team member not found.' })
    persistState()
    return json(response, 200, { removed: memberId, remaining: teamMembers.length })
  }
  if (pathname === '/api/team/remove' && request.method === 'POST') {
    try {
      const body = await readBody(request)
      const memberId = body.id
      if (!memberId) return json(response, 400, { error: 'Member id is required.' })
      const previousLength = teamMembers.length
      teamMembers = teamMembers.filter((member) => member.id !== memberId)
      if (teamMembers.length === previousLength) return json(response, 404, { error: 'Team member not found.' })
      persistState()
      return json(response, 200, { removed: memberId, remaining: teamMembers.length })
    } catch { return json(response, 400, { error: 'Invalid request.' }) }
  }
  if (pathname === '/api/alerts/test' && request.method === 'POST') {
    const recipients = teamMembers.filter((member) => member.status === 'active')
    const alert = { id: randomUUID(), channel: 'team-alert', sentAt: new Date().toISOString(), status: 'delivered', recipients: recipients.map((member) => ({ id: member.id, name: member.name, channels: member.channels })) }
    alertLog = [alert, ...alertLog].slice(0, 10)
    persistState()
    return json(response, 200, alert)
  }
  if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(response, pathname)
  json(response, 404, { error: 'Not found' })
})

function startServer(portNumber) {
  server.once('error', (error) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'EADDRINUSE' && portNumber < requestedPort + 10) {
      const nextPort = portNumber + 1
      console.warn(`Port ${portNumber} is busy; retrying on ${nextPort}`)
      startServer(nextPort)
      return
    }
    throw error
  })

  server.listen(portNumber, host, () => {
    console.log(`MOVA / flow listening on http://${host}:${portNumber}`)
  })
}

startServer(requestedPort)
