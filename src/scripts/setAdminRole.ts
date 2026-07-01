import type { UserRole } from "@prisma/client";
import { adminPrisma } from "../lib/prisma";

const [emailInput, roleInput] = process.argv.slice(2);
const role = roleInput?.toUpperCase() as UserRole | undefined;
const allowedRoles: UserRole[] = ["USER", "MODERATOR", "ADMIN"];

async function main() {
  if (!emailInput || !role || !allowedRoles.includes(role)) {
    throw new Error(
      "Usage: npm run admin:role -- <email> <USER|MODERATOR|ADMIN>"
    );
  }

  const user = await adminPrisma.user.update({
    where: { email: emailInput.trim().toLowerCase() },
    data: { role },
    select: { uid: true, email: true, role: true },
  });
  console.log(`Updated ${user.email} (${user.uid}) to ${user.role}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminPrisma.$disconnect();
  });
