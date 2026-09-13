import client from 'prom-client'

export const metricsRegistry = new client.Registry()
client.collectDefaultMetrics({ register: metricsRegistry, prefix: 'cryptoflow_' })

export const httpRequestDuration = new client.Histogram({
  name: 'cryptoflow_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
})
