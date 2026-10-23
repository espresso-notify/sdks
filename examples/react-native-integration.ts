import { usePushNotifications } from '@espresso-notify/react-native/hooks';
import { PushClient } from '@espresso-notify/react-native';

// ============================================================================
// INTEGRAÇÃO RECOMENDADA — Hook Declarativo (uma linha)
// ============================================================================

/**
 * Coloque em app/_layout.tsx (Expo Router) ou App.tsx, dentro do seu provider
 * de autenticação para ter acesso ao userId.
 *
 * O hook gerencia automaticamente:
 *   - requestPermissionsAsync() + getExpoPushTokenAsync()
 *   - register() no mount
 *   - identify() quando userId muda de null → valor
 *   - unregister() quando userId muda de valor → null
 *   - destroy() no unmount
 */
export function PushBootstrap({ userId }: { userId: string | null }) {
  usePushNotifications({
    projectId: 'pk_live_SEU_TOKEN_AQUI',
    externalId: userId,
    metadata: { app_name: 'MeuApp' },
  });

  return null;
}

/**
 * Para uso avançado: acessar o client para operações extras após o registro.
 */
export function PushBootstrapAdvanced({ userId, plan }: { userId: string | null; plan?: string }) {
  const { client, isReady } = usePushNotifications({
    projectId: 'pk_live_SEU_TOKEN_AQUI',
    externalId: userId,
  });

  // Atualiza metadata quando o plano do usuário muda
  if (isReady && client && plan) {
    client.devices.updateMetadata({ plan });
  }

  return null;
}

// ============================================================================
// INTEGRAÇÃO MANUAL — PushClient direto (para casos avançados)
// ============================================================================

/**
 * Use apenas se você já gerencia o ciclo de vida manualmente
 * ou precisa de controle total sobre quando chamar cada método.
 */
export const setupPushNotificationsManual = async () => {
  const pushClient = new PushClient({
    projectId: 'pk_live_EXAMPLE_KEY',
  });

  // Registrar o dispositivo (Anônimo)
  // O SDK coleta pushToken, platform, locale, timezone e app_version automaticamente.
  await pushClient.devices.register({
    metadata: {
      language: 'pt-BR',
      theme: 'dark',
    },
  });

  return pushClient;
};

/**
 * Login — vincula o dispositivo ao usuário
 */
export const onUserLogin = async (pushClient: PushClient, user: { id: string; name?: string; plan?: string; role?: string }) => {
  await pushClient.devices.identify({
    externalId: user.id,
    name: user.name,
    metadata: {
      plan: user.plan,
      role: user.role,
    },
  });
};

/**
 * Logout — token volta ao estado anônimo (não é deletado).
 * O dispositivo continua recebendo broadcasts.
 * No próximo login, chame apenas identify() — não precisa de register() novamente.
 */
export const onUserLogout = async (pushClient: PushClient) => {
  await pushClient.devices.unregister();
};
