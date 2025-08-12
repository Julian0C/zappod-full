// Edge Function: /redeem-code — MUST-FIX + metadata toggle (default OFF)
// Changes vs previous mustfix:
// - Adds SYNC_AUTH_METADATA env toggle ("1" to enable syncing auth.metadata)
// - Keeps state-aware date logic & DB triggers for history

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
);
const SYNC_AUTH_METADATA = Deno.env.get("SYNC_AUTH_METADATA") === "1"; // default OFF

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret"
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // optional internal secret gate
    const secret = Deno.env.get("INTERNAL_EDGE_SECRET");
    if (secret && req.headers.get("X-Internal-Secret") !== secret) {
      return new Response(JSON.stringify({ success: false, code: "unauthorized", message: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { code, user_id } = await req.json();
    if (!code || !user_id) {
      return new Response(JSON.stringify({ success: false, code: "invalid_request", message: "Missing code or user_id" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 1) Validate promo code
    const { data: promo, error: promoError } = await supabase
      .from("promo_codes")
      .select("code, category, is_active, expires_at, max_usage, current_usage, bonus_days")
      .eq("code", code)
      .single();

    if (promoError || !promo) {
      return new Response(JSON.stringify({ success: false, code: "code_not_found", message: "Invalid code" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (!promo.is_active) {
      return new Response(JSON.stringify({ success: false, code: "inactive_code", message: "Code inactive" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return new Response(JSON.stringify({ success: false, code: "expired_code", message: "Code expired" }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // null-safe max_usage check
    const maxUsageIsNumber = Number.isFinite(promo.max_usage);
    const currentUsage = promo.current_usage ?? 0;
    if (maxUsageIsNumber && currentUsage >= (promo.max_usage as number)) {
      return new Response(JSON.stringify({ success: false, code: "usage_exhausted", message: "Code usage exhausted" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2) For non-test categories, prevent multiple redemptions by same user/category
    if (promo.category !== "test") {
      const { data: redemption } = await supabase
        .from("promo_redemptions")
        .select("id")
        .eq("user_id", user_id)
        .eq("category", promo.category)
        .maybeSingle();
      if (redemption) {
        return new Response(JSON.stringify({ success: false, code: "already_redeemed", message: "User already redeemed this category" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 3) Record redemption (handle unique violation gracefully)
    const { error: redemptionError } = await supabase
      .from("promo_redemptions")
      .insert({ user_id, promo_code: promo.code, category: promo.category });
    if (redemptionError) {
      if ((redemptionError as any).code === "23505") {
        return new Response(JSON.stringify({ success: false, code: "already_redeemed", message: "User already redeemed this category" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      throw new Error(`Failed to record redemption: ${redemptionError.message}`);
    }

    // 4) Increment usage (best-effort; fully atomic requires RPC)
    const nextUsage = (promo.current_usage ?? 0) + 1;
    const { error: updateError } = await supabase
      .from("promo_codes")
      .update({ current_usage: nextUsage })
      .eq("code", code);
    if (updateError) {
      throw new Error(`Failed to update code usage: ${updateError.message}`);
    }

    // 5) State-aware end-date calculation (free/trial/basic*)
    const now = new Date();
    const nowIso = now.toISOString();

    const { data: current, error: curErr } = await supabase
      .from("user_subscription_status")
      .select("subscription_type, subscription_end_date, trial_end_date")
      .eq("user_id", user_id)
      .maybeSingle();
    if (curErr) throw new Error(`Failed to fetch subscription: ${curErr.message}`);

    const bonus = Number.isFinite(promo.bonus_days) ? (promo.bonus_days as number) : 0;
    let base = now; // default for free/unknown
    const st = (current?.subscription_type || 'free').toLowerCase();

    if (st === "trial" && current?.trial_end_date) {
      base = new Date(current.trial_end_date);
    } else if (st === "basic" || st === "basic_monthly" || st === "basic_yearly") {
      base = current?.subscription_end_date ? new Date(current.subscription_end_date) : now;
    }

    const newEnd = new Date(base);
    newEnd.setUTCDate(newEnd.getUTCDate() + bonus);
    const newEndIso = newEnd.toISOString();

    // 6) Upsert user_subscription_status (history via triggers)
    const upsertPayload: Record<string, any> = {
      user_id,
      subscription_type: "basic",
      is_subscribed: true,
      subscription_end_date: newEndIso,
      updated_at: nowIso,
      bonus_end_date: newEndIso,
    };

    const { error: subErr } = await supabase
      .from("user_subscription_status")
      .upsert(upsertPayload, { onConflict: "user_id" });
    if (subErr) {
      throw new Error(`Failed to upsert subscription: ${subErr.message}`);
    }

    // 7) (Optional) sync auth.metadata — controlled by SYNC_AUTH_METADATA (default OFF)
    if (SYNC_AUTH_METADATA) {
      const { error: metaErr } = await supabase.auth.admin.updateUserById(user_id, {
        user_metadata: {
          subscription_type: "basic",
          is_subscribed: true,
          subscription_end_date: newEndIso,
          updated_at: nowIso,
        },
      });
      if (metaErr) console.warn("auth.metadata update failed", metaErr);
    }

    return new Response(
      JSON.stringify({ success: true, code: "ok", bonus_days: promo.bonus_days, subscription_end_date: newEndIso }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("redeem-code error", err);
    return new Response(JSON.stringify({ success: false, code: "server_error", message: err?.message || String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
