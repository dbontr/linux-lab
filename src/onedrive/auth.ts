export const MICROSOFT_CLIENT_ID = import.meta.env.VITE_MICROSOFT_CLIENT_ID || '2b465be9-d210-4cfd-b5c4-3a4ad5ea0e92'
const TENANT = 'common'
const SCOPES = ['openid', 'profile', 'offline_access', 'Files.ReadWrite'] as const
const DB_NAME = 'linux-lab-auth'
const STORE = 'session'
const SESSION_KEY = 'onedrive'
const PKCE_VERIFIER = 'linux-lab.pkce.verifier'
const PKCE_STATE = 'linux-lab.pkce.state'
const REFRESH_MARGIN_MS = 90_000

export interface OneDriveSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId: string
  tenant: string
  scopes: string[]
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

let refreshInFlight: Promise<OneDriveSession> | null = null

export function oneDriveRedirectUri(): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href
}

export async function beginOneDriveConnect(): Promise<void> {
  const verifier = randomString(64)
  const state = randomString(32)
  sessionStorage.setItem(PKCE_VERIFIER, verifier)
  sessionStorage.setItem(PKCE_STATE, state)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64Url(new Uint8Array(digest))
  const url = new URL(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`)
  url.search = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: oneDriveRedirectUri(),
    response_mode: 'query',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  location.assign(url.href)
}

export async function finishOneDriveCallback(): Promise<boolean> {
  const params = new URLSearchParams(location.search)
  if (!params.has('code') && !params.has('error')) return false
  if (params.has('error')) {
    throw new Error(params.get('error_description') ?? params.get('error') ?? 'Microsoft sign-in failed')
  }
  const verifier = sessionStorage.getItem(PKCE_VERIFIER)
  const expectedState = sessionStorage.getItem(PKCE_STATE)
  if (!verifier || !expectedState || params.get('state') !== expectedState) {
    throw new Error('Microsoft sign-in state is invalid')
  }
  const code = params.get('code')
  if (!code) throw new Error('Microsoft sign-in did not return an authorization code')
  const tokens = await tokenRequest(new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: oneDriveRedirectUri(),
    scope: SCOPES.join(' '),
    code_verifier: verifier,
  }))
  await saveSession(sessionFromTokens(tokens))
  sessionStorage.removeItem(PKCE_VERIFIER)
  sessionStorage.removeItem(PKCE_STATE)
  history.replaceState(null, '', oneDriveRedirectUri())
  return true
}

export async function getOneDriveSession(): Promise<OneDriveSession | null> {
  if (typeof indexedDB === 'undefined') return null
  const db = await openDatabase()
  const value = await transact<OneDriveSession | undefined>(db, 'readonly', (store) => store.get(SESSION_KEY))
  db.close()
  return value && validSession(value) ? value : null
}

export async function disconnectOneDrive(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openDatabase()
  await transact(db, 'readwrite', (store) => store.delete(SESSION_KEY))
  db.close()
}

export async function getOneDriveAccessToken(): Promise<string> {
  const session = await getOneDriveSession()
  if (!session) throw new Error('OneDrive is not connected')
  if (session.expiresAt > Date.now() + REFRESH_MARGIN_MS) return session.accessToken
  const refresh = refreshInFlight ??= refreshSession(session)
  try {
    const next = await refresh
    await saveSession(next)
    return next.accessToken
  } finally {
    if (refreshInFlight === refresh) refreshInFlight = null
  }
}

async function refreshSession(session: OneDriveSession): Promise<OneDriveSession> {
  if (!session.refreshToken) throw new Error('Microsoft session expired; reconnect OneDrive')
  const tokens = await tokenRequest(new URLSearchParams({
    client_id: session.clientId,
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    scope: session.scopes.join(' '),
  }))
  return sessionFromTokens(tokens, session.refreshToken)
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const value = await response.json() as TokenResponse
  if (!response.ok || !value.access_token) {
    throw new Error(value.error_description ?? value.error ?? 'Microsoft token request failed')
  }
  return value
}

function sessionFromTokens(tokens: TokenResponse, previousRefreshToken = ''): OneDriveSession {
  return {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in ?? 3600)) * 1000,
    clientId: MICROSOFT_CLIENT_ID,
    tenant: TENANT,
    scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? [...SCOPES],
  }
}

async function saveSession(session: OneDriveSession): Promise<void> {
  if (!validSession(session)) throw new Error('Microsoft session is invalid')
  const db = await openDatabase()
  await transact(db, 'readwrite', (store) => store.put(session, SESSION_KEY))
  db.close()
}

function validSession(value: OneDriveSession): boolean {
  return !!value && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string'
    && Number.isFinite(value.expiresAt) && typeof value.clientId === 'string'
    && typeof value.tenant === 'string' && Array.isArray(value.scopes)
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open OneDrive session store'))
  })
}

function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = operation(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('OneDrive session operation failed'))
    tx.onabort = () => reject(tx.error ?? new Error('OneDrive session transaction aborted'))
  })
}

function randomString(bytes: number): string {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return base64Url(data)
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
