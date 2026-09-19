import { Agent, setGlobalDispatcher } from 'undici'
import { Resolver } from 'dns/promises'
import dns from 'dns'
import { logger } from './logger'

const resolver = new Resolver()
resolver.setServers(['8.8.8.8', '1.1.1.1'])

const dnsCache = new Map<string, { ips: string[]; expires: number }>()

export function initNetworkFix(): void {
  try {
    dns.setDefaultResultOrder('ipv4first')
  } catch {
    // Ignore if not supported
  }

  try {
    const agent = new Agent({
      connect: {
        lookup: (hostname, opts, cb) => {
          if (hostname.endsWith('jup.ag')) {
            const cached = dnsCache.get(hostname)
            if (cached && cached.expires > Date.now()) {
              if (opts && (opts as any).all) {
                return cb(null, cached.ips.map((ip) => ({ address: ip, family: 4 })) as any)
              }
              return cb(null, cached.ips[0] as any, 4)
            }

            resolver
              .resolve4(hostname)
              .then((ips) => {
                if (ips && ips.length > 0) {
                  dnsCache.set(hostname, { ips, expires: Date.now() + 5 * 60 * 1000 })
                  if (opts && (opts as any).all) {
                    return cb(null, ips.map((ip) => ({ address: ip, family: 4 })) as any)
                  }
                  return cb(null, ips[0] as any, 4)
                }
                dns.lookup(hostname, opts as any, cb as any)
              })
              .catch(() => {
                dns.lookup(hostname, opts as any, cb as any)
              })
            return
          }
          dns.lookup(hostname, opts as any, cb as any)
        },
      },
    })

    setGlobalDispatcher(agent)
    logger.info('[dnsFix] Custom IPv4 undici dispatcher initialized for Jupiter endpoints')
  } catch (err) {
    logger.warn({ err }, '[dnsFix] Could not initialize custom undici dispatcher')
  }
}
