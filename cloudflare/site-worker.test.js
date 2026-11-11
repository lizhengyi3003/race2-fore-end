import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from './site-worker.js'

test('serves assets without contacting the API origin', async () => {
  const response = await worker.fetch(new Request('https://site.test/'), {
    ASSETS: { fetch: async () => new Response('app') },
  })
  assert.equal(await response.text(), 'app')
})

test('forwards authenticated POSTs without following upstream redirects', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://backend.test/api/v1/example?q=1')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.get('Authorization'), 'Bearer test-token')
    assert.equal(await new Response(init.body).text(), '{"value":1}')
    assert.equal(init.redirect, 'manual')
    return new Response(null, { status: 307, headers: { Location: 'https://backend.test/admin/' } })
  }
  try {
    const response = await worker.fetch(new Request('https://site.test/api/v1/example?q=1', {
      method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: '{"value":1}',
    }), { BACKEND_ORIGIN: 'https://backend.test' })
    assert.equal(response.status, 307)
    assert.equal(response.headers.get('Location'), 'https://site.test/admin/')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  } finally { globalThis.fetch = original }
})

test('preserves SSE response bodies and content type', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('data: {"state":"running"}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
  try {
    const response = await worker.fetch(new Request('https://site.test/api/v1/risk/1/review/stream'), {
      BACKEND_ORIGIN: 'https://backend.test',
    })
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
    assert.equal(await response.text(), 'data: {"state":"running"}\n\n')
  } finally { globalThis.fetch = original }
})
