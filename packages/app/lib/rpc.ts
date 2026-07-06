/**
 * Shared RPC client + indexer construction for a deployment. Every persona
 * page and the wallet need the same `{rpcUrl, networkPassphrase, contracts}`
 * ChainClient and the same conditional IndexerClient — this is the one place
 * that builds them.
 */
import { ChainClient, IndexerClient } from "@ctd/sdk";
import type { Deployment } from "./deployment";

export function clientsFor(deployment: Deployment): { client: ChainClient; indexer?: IndexerClient } {
  const client = new ChainClient({
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: deployment.networkPassphrase,
    contracts: deployment.contracts,
  });
  const indexer = deployment.indexerUrl
    ? new IndexerClient({ baseUrl: deployment.indexerUrl })
    : undefined;
  return { client, indexer };
}
