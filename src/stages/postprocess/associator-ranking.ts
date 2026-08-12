import type { ChunkCandidate } from "../../types/documents.js";
import type { AssociationProposal } from "./associator-types.js";

export function score(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function compareChunkIds(left: unknown, right: unknown): number {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  if (Number.isFinite(a)) return -1;
  if (Number.isFinite(b)) return 1;
  return 0;
}

export function channelPriority(candidate: unknown): number {
  const record =
    candidate && typeof candidate === "object"
      ? (candidate as { associationChannel?: unknown; channel?: unknown })
      : {};
  const channel = record.associationChannel ?? record.channel;
  if (channel === "tag") return 0;
  if (channel === "vector") return 1;
  return 2;
}

export function mergeProposal(
  proposals: Map<number, AssociationProposal>,
  proposal: AssociationProposal,
  presentIds: Set<number>,
): void {
  if (presentIds.has(proposal.chunkId)) return;
  const previous = proposals.get(proposal.chunkId);
  if (
    !previous ||
    proposal.score > previous.score ||
    (proposal.score === previous.score &&
      proposal.channel === "tag" &&
      previous.channel === "vector")
  ) {
    proposals.set(proposal.chunkId, proposal);
  }
}

export function compareProposals(
  left: AssociationProposal,
  right: AssociationProposal,
): number {
  return (
    score(right.score) - score(left.score) ||
    channelPriority(left) - channelPriority(right) ||
    compareChunkIds(left.chunkId, right.chunkId)
  );
}

export function mergeCandidates(
  candidates: ChunkCandidate[],
  proposals: readonly AssociationProposal[],
): ChunkCandidate[] {
  const additions = proposals.map((proposal) => ({
    chunkId: proposal.chunkId,
    score: proposal.score,
    source: "associate",
    associationChannel: proposal.channel,
    associationOf: proposal.seedChunkId,
  }));
  return [...candidates, ...additions].sort(
    (left, right) =>
      score(right.score) - score(left.score) ||
      channelPriority(left) - channelPriority(right) ||
      compareChunkIds(left.chunkId, right.chunkId),
  );
}
