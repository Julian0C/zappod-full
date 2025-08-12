// supabase/functions/verify-apple-subscription/index.ts — MUST‑FIX + metadata toggle (default OFF)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const APPLE_SHARED_SECRET = Deno.env.get("APPLE_SHARED_SECRET");
const SYNC_AUTH_METADATA = Deno.env.get("SYNC_AUTH_METADATA") === "1"; // default OFF
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

function isUUID(v?: string): boolean {
  return !!v && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
}

async function callAppleVerifyReceipt(payload: unknown) {
  const prod = "https://buy.itunes.apple.com/verifyReceipt";
  const sandbox = "https://sandbox.itunes.apple.com/verifyReceipt";
  let res = await fetch(prod, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  let data: any = await res.json().catch(() => ({}));
  if (data?.status === 21007) {
    res = await fetch(sandbox, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    data = await res.json().catch(() => ({}));
  }
  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const secret = Deno.env.get("INTERNAL_EDGE_SECRET");
    if (secret && req.headers.get("X-Internal-Secret") !== secret) {
      return new Response(JSON.stringify({ success: false, code: "unauthorized", message: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json().catch(() => ({}));
    const receiptData: string | undefined = body?.receiptData;
    const userId: string | undefined = body?.userId || body?.user_id;

    if (!receiptData || !isUUID(userId)) {
      return new Response(JSON.stringify({ success: false, code: "invalid_request", message: "Require { receiptData, userId(UUID) }" }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const payload = { "receipt-data": receiptData, password: APPLE_SHARED_SECRET, "exclude-old-transactions": true };

    const data = await callAppleVerifyReceipt(payload);
    if (!data || typeof data.status !== "number") {
      return new Response(JSON.stringify({ success: false, code: "apple_no_response", message: "Apple verifyReceipt returned no/invalid payload" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (data.status !== 0) {
      const map: Record<number, { code: string; http: number; message: string }> = {
        21002: { code: "invalid_receipt", http: 400, message: "Malformed or invalid receipt" },
        21003: { code: "auth_failed", http: 401, message: "Receipt authentication failed" },
        21004: { code: "bad_shared_secret", http: 401, message: "Shared secret mismatch" },
        21005: { code: "apple_unavailable", http: 503, message: "Apple server temporarily unavailable" },
        21009: { code: "apple_internal", http: 502, message: "Apple internal data access error" },
        21010: { code: "revoked", http: 403, message: "User account or purchase has been revoked" },
      };
      const m = map[data.status] || { code: "verify_failed", http: 400, message: `verifyReceipt failed with status ${data.status}` };
      return new Response(JSON.stringify({ success: false, code: m.code, status: data.status, message: m.message }), { status: m.http, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const list: any[] = Array.isArray(data?.latest_receipt_info) && data.latest_receipt_info.length
      ? data.latest_receipt_info
      : (Array.isArray(data?.receipt?.in_app) ? data.receipt.in_app : []);

    if (!list.length) {
      await supabase.from("user_subscription_status").upsert({
        user_id: userId!,
        subscription_type: "free",
        subscription_start_date: null,
        subscription_end_date: null,
        is_subscribed: false,
        updated_at: nowIso,
      }, { onConflict: "user_id" });

      if (SYNC_AUTH_METADATA) {
        const { error: metaErr } = await supabase.auth.admin.updateUserById(userId!, {
          user_metadata: { subscription_type: "free", is_subscribed: false, updated_at: nowIso },
        });
        if (metaErr) console.warn("auth.metadata update failed", metaErr);
      }

      return new Response(JSON.stringify({ success: true, code: "no_active_transactions", updated_to: "free" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // choose max expires_date_ms
    const latest = list.reduce((best, cur) => {
      const bestMs = Number(best?.expires_date_ms || best?.purchase_date_ms || 0);
      const curMs = Number(cur?.expires_date_ms || cur?.purchase_date_ms || 0);
      return curMs > bestMs ? cur : best;
    });

    const expiresMs = Number(latest?.expires_date_ms || 0);
    const purchaseMs = Number(latest?.purchase_date_ms || 0);
    const productId: string = latest?.product_id || "";

    const active = expiresMs > now.getTime();

    if (!active) {
      await supabase.from("user_subscription_status").upsert({
        user_id: userId!,
        subscription_type: "free",
        subscription_start_date: null,
        subscription_end_date: null,
        is_subscribed: false,
        updated_at: nowIso,
      }, { onConflict: "user_id" });

      if (SYNC_AUTH_METADATA) {
        const { error: metaErr } = await supabase.auth.admin.updateUserById(userId!, {
          user_metadata: { subscription_type: "free", is_subscribed: false, updated_at: nowIso },
        });
        if (metaErr) console.warn("auth.metadata update failed", metaErr);
      }

      return new Response(JSON.stringify({ success: true, code: "expired", updated_to: "free" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const mapProductToType = (pid: string): "basic_monthly" | "basic_yearly" | "basic" => {
      if (pid === "zappod_basic_plan") return "basic_monthly";
      if (pid === "zappod_yearly_basic_plan") return "basic_yearly";
      return "basic";
    };

    const subscriptionType = mapProductToType(productId);
    const startDateIso = purchaseMs ? new Date(purchaseMs).toISOString() : nowIso;
    const endDateIso = new Date(expiresMs).toISOString();

    const { error: upErr } = await supabase.from("user_subscription_status").upsert({
      user_id: userId!,
      subscription_type: subscriptionType,
      subscription_start_date: startDateIso,
      subscription_end_date: endDateIso,
      is_subscribed: true,
      updated_at: nowIso,
    }, { onConflict: "user_id" });
    if (upErr) throw upErr;

    if (SYNC_AUTH_METADATA) {
      const { error: metaErr } = await supabase.auth.admin.updateUserById(userId!, {
        user_metadata: {
          subscription_type: subscriptionType,
          is_subscribed: true,
          subscription_end_date: endDateIso,
          updated_at: nowIso,
        },
      });
      if (metaErr) console.warn("auth.metadata update failed", metaErr);
    }

    return new Response(JSON.stringify({ success: true, code: "ok", type: subscriptionType, subscription_end_date: endDateIso }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("verify-apple-subscription error", err);
    return new Response(JSON.stringify({ success: false, code: "server_error", message: err?.message || String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
