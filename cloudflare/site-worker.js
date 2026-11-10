export default {
  async fetch(request, env) {
    const incoming = new URL(request.url)
    if (incoming.pathname === '/healthz') {
      return Response.json({ status: 'ok', service: 'race3-frontend' })
    }
    const backendPath = incoming.pathname.startsWith('/api/') ||
      incoming.pathname === '/admin' || incoming.pathname.startsWith('/admin/')
    if (!backendPath) return env.ASSETS.fetch(request)
    const target = new URL(env.BACKEND_ORIGIN)
    target.pathname = incoming.pathname
    target.search = incoming.search
    const headers = new Headers(request.headers)
    headers.delete('host')
    // Never follow redirects while forwarding credentials to the upstream.
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      })
      const responseHeaders = new Headers(upstream.headers)
      responseHeaders.set('Cache-Control', 'no-store')
      const location = responseHeaders.get('Location')
      if (location) {
        const redirected = new URL(location, target)
        if (redirected.origin === target.origin) {
          responseHeaders.set('Location', incoming.origin + redirected.pathname + redirected.search + redirected.hash)
        }
      }
      // Preserve streaming responses, including AI review SSE.
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
    } catch {
      console.error(JSON.stringify({ event: 'backend_unavailable', path: incoming.pathname }))
      return Response.json({ code: 502, message: '后端暂时不可用，请稍后重试', data: null }, { status: 502 })
    }
  },
}
