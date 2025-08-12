// Edge Function: /expire-subscription-status — MUST-FIX + metadata toggle (default OFF)
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

function isUUID(v?: string): boolean {
  return !!v && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const secret = Deno.env.get("INTERNAL_EDGE_SECRET");
    if (secret && req.headers.get("X-Internal-Secret") !== secret) {
      return new Response(JSON.stringify({ success: false, code: "unauthorized", message: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json().catch(() => ({}));
    const userId: string | undefined = body?.userId || body?.user_id;

    if (!isUUID(userId)) {
      return new Response(JSON.stringify({ success: false, code: "invalid_request", message: "Require userId (UUID)" }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const now = new Date();
    const updatedAt = now.toISOString();

    const { data: cur, error: curErr } = await supabase
      .from("user_subscription_status")
      .select("subscription_type, subscription_end_date")
      .eq("user_id", userId)
      .maybeSingle();

    if (curErr) {
      return new Response(JSON.stringify({ success: false, code: "fetch_failed", message: curErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!cur) {
      return new Response(JSON.stringify({ success: false, code: "not_found", message: "No subscription row for user" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const type = (cur.subscription_type || "").toLowerCase();
    const inBasicFamily = ["basic", "basic_monthly", "basic_yearly"].includes(type);
    const end = cur.subscription_end_date ? new Date(cur.subscription_end_date) : null;
    const isExpired = !end || end.getTime() <= now.getTime();

    if (!inBasicFamily || !isExpired) {
      return new Response(JSON.stringify({ success: false, code: "not_eligible", message: "Transition allowed only for expired basic/basic_monthly/basic_yearly", details: { subscription_type: type, subscription_end_date: cur.subscription_end_date } }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: upd, error: updErr } = await supabase
      .from("user_subscription_status")
      .update({
        subscription_type: "free",
        is_subscribed: false,
        subscription_end_date: null,
        bonus_end_date: null,
        updated_at: updatedAt,
      })
      .eq("user_id", userId)
      .select("subscription_type, is_subscribed, subscription_end_date, updated_at")
      .single();

    if (updErr) {
      return new Response(JSON.stringify({ success: false, code: "update_failed", message: updErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (SYNC_AUTH_METADATA) {
      const { error: metaErr } = await supabase.auth.admin.updateUserById(userId!, {
        user_metadata: { subscription_type: "free", is_subscribed: false, updated_at: updatedAt },
      });
      if (metaErr) console.warn("auth.metadata update failed", metaErr);
    }

    return new Response(JSON.stringify({ success: true, code: "ok", new_state: upd }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("expire-subscription-status error", err);
    return new Response(JSON.stringify({ success: false, code: "server_error", message: err?.message || String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
