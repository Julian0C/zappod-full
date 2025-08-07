// Edge Function: redeem-code
// This function validates a redeem code, updates usage, and records redemption.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Supabase client with service role key
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  try {
    const { code, user_id } = await req.json();
    if (!code || !user_id) {
      return new Response(JSON.stringify({
        success: false,
        message: "Missing code or user_id"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // 1. Validate code
    const { data: promo, error: promoError } = await supabase.from("promo_codes").select("*").eq("code", code).single();
    if (promoError || !promo) {
      return new Response(JSON.stringify({
        success: false,
        message: "Invalid code"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (!promo.is_active) {
      return new Response(JSON.stringify({
        success: false,
        message: "Code inactive"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return new Response(JSON.stringify({
        success: false,
        message: "Code expired"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (promo.current_usage >= promo.max_usage) {
      return new Response(JSON.stringify({
        success: false,
        message: "Code has already been used"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // 2. For non-test categories, check if user already redeemed this category
    if (promo.category !== "test") {
      const { data: redemption } = await supabase.from("promo_redemptions").select("*").eq("user_id", user_id).eq("category", promo.category).maybeSingle();
      if (redemption) {
        return new Response(JSON.stringify({
          success: false,
          message: "User already redeemed this category"
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
    }
    // 3. Record redemption
    const { error: redemptionError } = await supabase.from("promo_redemptions").insert({
      user_id,
      promo_code: promo.code,
      category: promo.category
    });
    if (redemptionError) {
      throw new Error(`Failed to record redemption: ${redemptionError.message}`);
    }
    // 4. Increment code usage
    const { error: updateError } = await supabase.from("promo_codes").update({
      current_usage: promo.current_usage + 1
    }).eq("code", code);
    if (updateError) {
      throw new Error(`Failed to update code usage: ${updateError.message}`);
    }
    // 5. Return success with bonus_days
    return new Response(JSON.stringify({
      success: true,
      bonus_days: promo.bonus_days
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      success: false,
      message: err.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
