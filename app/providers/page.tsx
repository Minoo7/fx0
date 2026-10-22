import ProviderSettings from '../../components/provider-settings'

export default function ProvidersPage() {
  return <main className="mx-auto max-w-3xl p-6">
    <a href="/" className="text-sm underline">← fx0</a>
    <h1 className="mt-6 text-2xl">Model providers</h1>
    <p className="mt-2 text-sm text-foreground-secondary">Provider connections for this fx0 deployment. API keys can also be configured in Dokploy’s fx0 Environment.</p>
    <ProviderSettings />
  </main>
}
