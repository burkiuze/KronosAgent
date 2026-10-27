import { json } from "../_lib/http.js";
import { userFromRequest } from "../_lib/clerk.js";
import { rpc } from "../_lib/db.js";
import { TIERS } from "../_lib/plans.js";

export async function GET(req) {
  const user = await userFromRequest(req);
  if (!user) return json({ signedIn: false }, 401);
  const me = await rpc("kronos_me", { p_user: user });
  const tier = me.tier && TIERS[me.tier] ? me.tier : null;
  return json({
    signedIn: true,
    tier,
    expiresAt: tier ? me.expires_at : null,
    usedToday: Number(me.used_today) || 0,
    dailyTokens: tier ? TIERS[tier].dailyTokens : 0,
  });
}
