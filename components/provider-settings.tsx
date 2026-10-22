'use client'

import { useEffect, useState, type FormEvent } from 'react'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'

interface Provider { id: string; name: string; configured: boolean; models: number; methods: { type: string; label: string }[] }
interface Login { id: string; provider: string; status: string; events: AuthEvent[]; prompt?: AuthPrompt & { id: string } }
async function api(body?: object, method = 'POST') {
  const response = await fetch('/api/providers', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Provider request failed')
  return result
}

export default function ProviderSettings() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [login, setLogin] = useState<Login | null>(null)
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const response = await fetch('/api/providers', { cache: 'no-store' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Unable to load providers')
    setProviders(result.providers)
  }
  useEffect(() => { void load().catch(e => setError(e.message)) }, [])
  useEffect(() => {
    if (!login || login.status !== 'pending') return
    let active = true
    const timer = setInterval(() => {
      void fetch(`/api/providers?login=${login.id}`, { cache: 'no-store' }).then(async response => {
        const next = await response.json()
        if (!active) return
        if (!response.ok) throw new Error(next.error)
        setLogin(next)
        if (next.status === 'done') await load()
      }).catch(e => { setError(e.message); clearInterval(timer) })
    }, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [login?.id, login?.status])
  async function connect(provider: string, type: string) {
    setBusy(true); setError(''); setAnswer('')
    try { setLogin(await api({ provider, type })) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!login?.prompt) return
    setBusy(true); setError('')
    try {
      setLogin(await api({ login: login.id, prompt: login.prompt.id, value: answer }))
      setAnswer('')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <>
    {error && <p role="alert" className="my-4 text-red-500">{error}</p>}
    {login && <section className="my-6 border border-border p-4" aria-label="Provider connection">
      <h2>{login.provider}: {login.status === 'done' ? 'Connected' : login.status === 'failed' ? 'Connection failed; try again' : 'Connecting…'}</h2>
      {login.events.map((event, i) => <div className="my-2 break-words text-sm" key={i}>
        {event.type === 'auth_url' ? <><a className="underline" href={event.url} target="_blank" rel="noreferrer">Open provider sign-in</a><p>{event.instructions}</p></>
          : event.type === 'device_code' ? <><a className="underline" href={event.verificationUri} target="_blank" rel="noreferrer">Open provider sign-in</a><p>Code: <strong>{event.userCode}</strong></p></>
          : <><p>{event.message}</p>{event.type === 'info' && event.links?.map(link => <a key={link.url} className="mr-3 underline" href={link.url} target="_blank" rel="noreferrer">{link.label ?? 'Open link'}</a>)}</>}
      </div>)}
      {login.prompt && <form onSubmit={submit} className="my-3 flex flex-col gap-2">
        <label htmlFor="provider-answer">{login.prompt.message}</label>
        {login.prompt.type === 'select'
          ? <select id="provider-answer" value={answer} onChange={e => setAnswer(e.target.value)} className="border border-border p-2">
            <option value="" disabled>Choose…</option>{login.prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          : <input id="provider-answer" type={login.prompt.type === 'secret' ? 'password' : 'text'} value={answer} onChange={e => setAnswer(e.target.value)} autoComplete="off" className="border border-border p-2" />}
        <button disabled={busy || !answer} className="border border-border p-2">Continue</button>
      </form>}
      <button className="mt-2 text-sm underline" onClick={() => {
        if (login.status === 'pending') void api({ login: login.id, cancel: true }).catch(e => setError(e.message))
        setLogin(null); setAnswer('')
      }}>{login.status === 'pending' ? 'Cancel' : 'Close'}</button>
    </section>}
    <ul className="mt-6 divide-y divide-border">{providers.map(provider => <li key={provider.id} className="py-4">
      <div className="flex flex-wrap items-center gap-3"><h2 className="font-medium">{provider.name}</h2>
        <span className="text-xs text-foreground-secondary">{provider.configured ? 'Connected' : 'Not connected'} · {provider.models} models</span></div>
      <div className="mt-2 flex flex-wrap gap-3">{provider.methods.map(method => <button key={method.type} className="text-sm underline" disabled={busy || login?.status === 'pending'} onClick={() => void connect(provider.id, method.type)}>{method.label}</button>)}
        {provider.configured && <button className="text-sm underline" disabled={busy} onClick={() => {
          setBusy(true); void api({ provider: provider.id }, 'DELETE').then(load).catch(e => setError(e.message)).finally(() => setBusy(false))
        }}>Disconnect saved credentials</button>}
      </div>
    </li>)}</ul>
  </>
}
