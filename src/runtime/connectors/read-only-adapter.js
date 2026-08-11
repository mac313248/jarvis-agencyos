// src/runtime/connectors/read-only-adapter.js
// F-11 read-only connector adapters.
//
// Writer connectors are DISABLED (stop condition). Adapters may only perform
// read operations against fixture/local data in this foundation slice.
// Live external side effects and business-write autonomy remain DISABLED.
//
// Credentials arrive only as opaque credential_broker_ref handles — never as
// raw secrets in the worker message.

import {
  assertReadOnlyConnector,
  ConnectorValidationError,
} from '../../contracts/connector.js';
import {
  assertNoRawSecretsInWorkerMessage,
  CredentialBrokerError,
} from '../credential-broker.js';
import {
  assertBusinessWriteAutonomyDisabled,
  assertWriterConnectorsDisabled,
  WRITER_CONNECTORS_ENABLED,
} from '../autonomy.js';

export const READ_ONLY_ADAPTER_SURFACE = 'connector.read_only';

const WRITE_OPERATIONS = new Set([
  'create', 'update', 'delete', 'upsert', 'write', 'mutate', 'send', 'publish',
]);

export class ConnectorAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectorAdapterError';
    this.code = code;
  }
}

/**
 * @param {{
 *   broker: ReturnType<import('../credential-broker.js').createCredentialBroker>,
 *   fixtureStore?: Map<string, object>,
 * }} opts
 */
export function createReadOnlyConnectorAdapter(opts) {
  const broker = opts.broker;
  const fixtureStore = opts.fixtureStore ?? new Map();

  if (!broker) {
    throw new ConnectorAdapterError('MISSING_BROKER', 'credential broker required');
  }

  return {
    surface: READ_ONLY_ADAPTER_SURFACE,

    seedFixture(key, value) {
      fixtureStore.set(key, value);
    },

    /**
     * Execute a read-only connector operation.
     * Rejects writer connectors / write operations (stop conditions).
     */
    async execute({ connector, tenant_id, worker_message, resource_key }) {
      assertBusinessWriteAutonomyDisabled();
      assertWriterConnectorsDisabled();

      if (WRITER_CONNECTORS_ENABLED) {
        throw new ConnectorAdapterError('WRITER_CONNECTOR_ENABLED', 'writer connector enabled (stop)');
      }

      try {
        assertReadOnlyConnector(connector);
      } catch (e) {
        if (e instanceof ConnectorValidationError) {
          throw new ConnectorAdapterError('WRITER_CONNECTOR_DISABLED', e.message);
        }
        throw e;
      }

      if (connector.status === 'disabled') {
        throw new ConnectorAdapterError('CONNECTOR_DISABLED', 'connector is disabled');
      }

      assertNoRawSecretsInWorkerMessage(worker_message);

      if (worker_message.tenant_id !== tenant_id) {
        throw new ConnectorAdapterError('TENANT_MISMATCH', 'worker message tenant mismatch');
      }
      if (worker_message.connector_id !== connector.connector_id) {
        throw new ConnectorAdapterError('CONNECTOR_MISMATCH', 'worker message connector mismatch');
      }
      if (worker_message.credential_broker_ref !== connector.credential_broker_ref) {
        throw new ConnectorAdapterError(
          'CREDENTIAL_REF_MISMATCH',
          'worker message credential_broker_ref mismatch'
        );
      }

      const op = String(worker_message.operation || '').toLowerCase();
      if (WRITE_OPERATIONS.has(op)) {
        throw new ConnectorAdapterError(
          'WRITE_OPERATION_FORBIDDEN',
          `write operation forbidden on read-only adapter: ${op}`
        );
      }
      if (op !== 'read' && op !== 'list' && op !== 'get') {
        throw new ConnectorAdapterError(
          'UNSUPPORTED_OPERATION',
          `unsupported read-only operation: ${op}`
        );
      }

      // Resolve opaque handle (reader workload). Never put secret on result.
      let handle;
      try {
        handle = broker.resolveHandle({
          tenant_id,
          credential_broker_ref: connector.credential_broker_ref,
          workload: 'reader',
        });
      } catch (e) {
        if (e instanceof CredentialBrokerError) throw e;
        throw e;
      }

      const key = resource_key ?? worker_message.payload?.resource_key;
      if (typeof key !== 'string' || key.length === 0) {
        throw new ConnectorAdapterError('MISSING_RESOURCE', 'resource_key required');
      }

      const data = fixtureStore.has(key) ? fixtureStore.get(key) : null;

      return {
        ok: true,
        surface: READ_ONLY_ADAPTER_SURFACE,
        connector_id: connector.connector_id,
        tenant_id,
        operation: op,
        resource_key: key,
        data,
        credential_broker_ref: handle.credential_broker_ref,
        // Explicit proof: no raw secret fields on adapter result.
      };
    },
  };
}
