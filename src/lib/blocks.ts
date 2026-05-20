import prisma from "./prisma";

export type BlockStatus =
  | "NONE"
  | "BLOCKED_BY_ME"
  | "BLOCKED_ME"
  | "MUTUAL_BLOCK";

type PrismaLike = typeof prisma;

type BlockRow = { blockerId: string; blockedId: string };

export type BlockContext = {
  blockedPeerIds: string[];
  isBlocked: (peerId: string | null | undefined) => boolean;
  getStatus: (peerId: string | null | undefined) => BlockStatus;
};

export function getBlockStatusFromRows(
  viewerId: string,
  targetId: string,
  blocks: BlockRow[]
): BlockStatus {
  const blockedByMe = blocks.some(
    (block) => block.blockerId === viewerId && block.blockedId === targetId
  );
  const blockedMe = blocks.some(
    (block) => block.blockerId === targetId && block.blockedId === viewerId
  );

  if (blockedByMe && blockedMe) return "MUTUAL_BLOCK";
  if (blockedByMe) return "BLOCKED_BY_ME";
  if (blockedMe) return "BLOCKED_ME";
  return "NONE";
}

export async function getBlockStatus(
  viewerId: string,
  targetId: string,
  client: PrismaLike = prisma
): Promise<BlockStatus> {
  if (viewerId === targetId) return "NONE";

  const blocks = await client.userBlock.findMany({
    where: {
      OR: [
        { blockerId: viewerId, blockedId: targetId },
        { blockerId: targetId, blockedId: viewerId },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });

  return getBlockStatusFromRows(viewerId, targetId, blocks);
}

export async function areUsersBlocked(
  firstUserId: string,
  secondUserId: string,
  client: PrismaLike = prisma
): Promise<boolean> {
  if (firstUserId === secondUserId) return false;

  const block = await client.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: firstUserId, blockedId: secondUserId },
        { blockerId: secondUserId, blockedId: firstUserId },
      ],
    },
    select: { id: true },
  });

  return !!block;
}

async function getBlockRows(
  userId: string,
  client: PrismaLike = prisma
): Promise<BlockRow[]> {
  return client.userBlock.findMany({
    where: {
      OR: [{ blockerId: userId }, { blockedId: userId }],
    },
    select: { blockerId: true, blockedId: true },
  });
}

export async function getBlockedPeerIds(
  userId: string,
  client: PrismaLike = prisma
): Promise<string[]> {
  const blocks = await getBlockRows(userId, client);

  return getBlockedPeerIdsFromRows(userId, blocks);
}

function getBlockedPeerIdsFromRows(userId: string, blocks: BlockRow[]): string[] {
  return Array.from(
    new Set(
      blocks.map((block) =>
        block.blockerId === userId ? block.blockedId : block.blockerId
      )
    )
  );
}

export async function getBlockContext(
  userId: string,
  client: PrismaLike = prisma
): Promise<BlockContext> {
  const blocks = await getBlockRows(userId, client);
  const blockedPeerIds = getBlockedPeerIdsFromRows(userId, blocks);
  const blockedPeerIdSet = new Set(blockedPeerIds);

  return {
    blockedPeerIds,
    isBlocked: (peerId) =>
      !!peerId && peerId !== userId && blockedPeerIdSet.has(peerId),
    getStatus: (peerId) =>
      peerId && peerId !== userId
        ? getBlockStatusFromRows(userId, peerId, blocks)
        : "NONE",
  };
}

export async function filterBlockedRecipientIds(
  senderId: string,
  recipientIds: string[],
  client: PrismaLike = prisma
): Promise<string[]> {
  const uniqueRecipientIds = Array.from(
    new Set(recipientIds.filter((recipientId) => recipientId !== senderId))
  );

  if (uniqueRecipientIds.length === 0) return [];

  const blocks = await client.userBlock.findMany({
    where: {
      OR: [
        { blockerId: senderId, blockedId: { in: uniqueRecipientIds } },
        { blockerId: { in: uniqueRecipientIds }, blockedId: senderId },
      ],
    },
    select: { blockerId: true, blockedId: true },
  });

  const blockedRecipientIds = new Set(
    blocks.map((block) =>
      block.blockerId === senderId ? block.blockedId : block.blockerId
    )
  );

  return uniqueRecipientIds.filter(
    (recipientId) => !blockedRecipientIds.has(recipientId)
  );
}
