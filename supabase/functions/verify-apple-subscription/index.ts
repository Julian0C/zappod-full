// supabase/functions/verify-apple-subscription/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js';
// import type { Database } from '../../_shared/database.types.ts' (optional)
serve(async (req)=>{
  const { receiptData, userId } = await req.json();
  if (!receiptData || !userId) {
    return new Response(JSON.stringify({
      error: 'Missing input'
    }), {
      status: 400
    });
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const payload = {
    'receipt-data': receiptData,
    'password': Deno.env.get('APPLE_SHARED_SECRET'),
    'exclude-old-transactions': true
  };
  // Step 1: Try production URL
  let response = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json'
    }
  });
  let data = await response.json();
  // Step 2: Retry with sandbox if status === 21007
  if (data.status === 21007) {
    response = await fetch('https://sandbox.itunes.apple.com/verifyReceipt', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json'
      }
    });
    data = await response.json();
  }
  if (data.status !== 0) {
    return new Response(JSON.stringify({
      error: 'Receipt invalid',
      status: data.status
    }), {
      status: 400
    });
  }
  const latest = data.latest_receipt_info?.[data.latest_receipt_info.length - 1];
  // 🔴 No active subscription or expired
  if (!latest || Number(latest.expires_date_ms) < Date.now()) {
    await supabase.from('user_subscription_status').upsert({
      user_id: userId,
      subscription_type: 'free',
      subscription_start_date: null,
      subscription_end_date: null,
      updated_at: new Date().toISOString()
    });
    return new Response(JSON.stringify({
      status: 'expired',
      updated_to: 'free'
    }), {
      status: 200
    });
  }
  // ✅ Valid subscription
  const startDate = new Date(Number(latest.purchase_date_ms));
  const endDate = new Date(Number(latest.expires_date_ms));
  const productId = latest.product_id;
  const subscriptionType = productId === 'zappod_basic_plan' ? 'basic_monthly' : productId === 'zappod_yearly_basic_plan' ? 'basic_yearly' : 'unknown';
  // Update current subscription status
  await supabase.from('user_subscription_status').upsert({
    user_id: userId,
    subscription_type: subscriptionType,
    subscription_start_date: startDate.toISOString(),
    subscription_end_date: endDate.toISOString(),
    updated_at: new Date().toISOString()
  });
  // Add to subscription history
  await supabase.from('subscription_history').insert({
    user_id: userId,
    subscription_type: subscriptionType,
    start_date: startDate.toISOString(),
    end_date: endDate.toISOString(),
    status: 'active',
    payment_method: 'apple',
    created_at: new Date().toISOString()
  });
  return new Response(JSON.stringify({
    status: 'success',
    type: subscriptionType
  }), {
    status: 200
  });
});
