import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ScrollView, View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import notifyKit, { EventType } from 'react-native-notify-kit'
import { capabilities, PushClient } from '@espresso-notify/react-native'
import type { PermissionStatus } from '@espresso-notify/react-native'
import { useEventLog } from './useEventLog'
import { requestPushPermission } from './pushClient'

interface ReceivedItem {
  id: string
  title: string
  body: string
  notificationId?: string | number
}

export interface PushTestScreenProps {
  mode: 'expo' | 'bare'
  isReady: boolean
  pushToken: string | null
  client: PushClient | null
  permissionStatus: PermissionStatus
  error: Error | null
  externalId: string | null
  onIdentify: (id: string) => void
  onLogout: () => void
}

export function PushTestScreen(p: PushTestScreenProps) {
  const log = useEventLog()
  const [userId, setUserId] = useState('')
  const [received, setReceived] = useState<ReceivedItem[]>([])
  const [selected, setSelected] = useState<ReceivedItem | null>(null)
  const caps = capabilities()

  // Section 5 — foreground received notifications (bare / notify-kit path).
  useEffect(() => {
    if (!notifyKit?.onForegroundEvent) return
    const unsub = notifyKit.onForegroundEvent(({ type, detail }: { type: number; detail: any }) => {
      if (type !== EventType?.DELIVERED) return
      const n = detail?.notification ?? {}
      const data = n.data ?? {}
      const item: ReceivedItem = {
        id: String(n.id ?? `${Date.now()}-${Math.round(received.length)}`),
        title: n.title ?? '(no title)',
        body: n.body ?? '',
        notificationId: data.notificationId ?? data.notification_id,
      }
      setReceived((prev) => [item, ...prev].slice(0, 30))
      log.push('notification received', item.title)
    })
    return () => {
      if (typeof unsub === 'function') unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const devices = p.client?.devices ?? null
  const trackId = selected?.notificationId ?? received[0]?.notificationId

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <Text style={s.h1}>Espresso Push Test · {p.mode}</Text>

      <Section title="Status">
        <Row k="isReady" v={String(p.isReady)} />
        <Row k="permission" v={String(p.permissionStatus)} />
        <Row k="platform" v={Platform.OS} />
        <Row k="pushProvider" v={caps.pushProvider} />
        <Row k="displayAdapter" v={caps.displayAdapter} />
        <Row k="transport" v={p.client ? p.client.transportKind : `${caps.nativeTransport ? 'native' : 'js'} (no client yet)`} />
        {p.error ? <Row k="error" v={p.error.message} /> : null}
      </Section>

      <Section title="Permission">
        <Btn
          label="Request permission"
          onPress={() => log.run('requestPermissions', requestPushPermission)}
        />
      </Section>

      <Section title="Push token">
        <Text selectable style={s.mono}>
          {p.pushToken ?? '(none yet)'}
        </Text>
        <Btn
          label="Copy token"
          disabled={!p.pushToken}
          onPress={() => {
            if (p.pushToken) {
              Clipboard.setString(p.pushToken)
              log.push('token copied')
            }
          }}
        />
      </Section>

      <Section title="Identity">
        <Row k="externalId" v={p.externalId ?? '(anonymous)'} />
        <TextInput
          style={s.input}
          placeholder="external user id"
          autoCapitalize="none"
          value={userId}
          onChangeText={setUserId}
        />
        <Btn
          label="Identify"
          disabled={!userId}
          onPress={() => {
            p.onIdentify(userId)
            log.push('identify (via usePushIdentity)', userId)
          }}
        />
        <Btn
          label="Logout (unregister)"
          onPress={() => {
            p.onLogout()
            log.push('logout (via usePushIdentity)')
          }}
        />
      </Section>

      <Section title={`Received (${received.length})`}>
        {received.length === 0 ? <Text style={s.dim}>none yet — send a push to this device</Text> : null}
        {received.map((r) => (
          <Pressable
            key={r.id}
            onPress={() => setSelected(r)}
            style={[s.recv, selected?.id === r.id && s.recvSel]}
          >
            <Text style={s.recvT}>{r.title}</Text>
            <Text style={s.dim}>
              {r.body} · id={String(r.notificationId ?? '—')}
            </Text>
          </Pressable>
        ))}
      </Section>

      <Section title="Tracking + metadata">
        <Text style={s.dim}>target notificationId: {String(trackId ?? '—')}</Text>
        <Btn label="trackOpen" disabled={!devices || trackId == null} onPress={() => log.run('trackOpen', () => devices!.trackOpen(trackId!))} />
        <Btn label="trackClick" disabled={!devices || trackId == null} onPress={() => log.run('trackClick', () => devices!.trackClick(trackId!))} />
        <Btn label="trackReceived" disabled={!devices || trackId == null} onPress={() => log.run('trackReceived', () => devices!.trackReceived(trackId!))} />
        <Btn label="trackDismissed" disabled={!devices || trackId == null} onPress={() => log.run('trackDismissed', () => devices!.trackDismissed(trackId!))} />
        <Btn label="trackAppOpened" disabled={!devices} onPress={() => log.run('trackAppOpened', () => devices!.trackAppOpened())} />
        <Btn label="updateMetadata {theme:dark}" disabled={!devices} onPress={() => log.run('updateMetadata', () => devices!.updateMetadata({ theme: 'dark' }))} />
        <Btn label="registerCategories" disabled={!devices} onPress={() => log.run('registerCategories', () => devices!.registerCategories())} />
      </Section>

      <Section title="Event log">
        {log.entries.map((e) => (
          <Text key={e.id} style={[s.logLine, { color: e.ok ? '#2e7d32' : '#c62828' }]}>
            {e.at} {e.ok ? '✓' : '✗'} {e.label}
            {e.detail ? ` — ${e.detail}` : ''}
          </Text>
        ))}
      </Section>
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.h2}>{title}</Text>
      {children}
    </View>
  )
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.row}>
      <Text style={s.k}>{k}</Text>
      <Text style={s.v}>{v}</Text>
    </View>
  )
}
function Btn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[s.btn, disabled && s.btnOff]}>
      <Text style={s.btnT}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fafafa' },
  content: { padding: 16, paddingTop: 56, gap: 12 },
  h1: { fontSize: 20, fontWeight: '700' },
  h2: { fontSize: 15, fontWeight: '600', marginBottom: 6 },
  section: { backgroundColor: '#fff', borderRadius: 10, padding: 12, gap: 8, borderWidth: 1, borderColor: '#eee' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  k: { color: '#666' },
  v: { fontWeight: '600' },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10 },
  btn: { backgroundColor: '#6f4e37', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  btnOff: { backgroundColor: '#ccc' },
  btnT: { color: '#fff', fontWeight: '600' },
  dim: { color: '#999', fontSize: 12 },
  recv: { borderWidth: 1, borderColor: '#eee', borderRadius: 8, padding: 8 },
  recvSel: { borderColor: '#6f4e37', backgroundColor: '#f3ece6' },
  recvT: { fontWeight: '600' },
  logLine: { fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
})
