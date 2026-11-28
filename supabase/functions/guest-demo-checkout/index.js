const previewOrigin = "https://leangut36.github.io";
Deno.serve(async(req)=>{
const headers={"Access-Control-Allow-Origin":previewOrigin,"Cache-Control":"no-store","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
if(req.headers.get("Origin")!==previewOrigin)return reply({error:"Origin forbidden"},403);
if(req.method==="OPTIONS")return new Response(null,{headers});
if(req.method!=="POST")return reply({error:"POST required"},405);
const key=(Deno.env.get("STRIPE_SECRET_KEY")||"").trim();
if(!/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key))return reply({error:"Stripe test key missing"},503);
let stage="request";
try{
const {ids,embedded}=await req.json();if(typeof embedded!=="boolean"&&embedded!==undefined)return reply({error:"Invalid checkout mode"},400);const pk=Deno.env.get("STRIPE_PUBLISHABLE_KEY")||"";if(embedded&&!pk.startsWith("pk_test_"))return reply({error:"Test publishable key missing"},503);
if(!Array.isArray(ids)||ids.length<1||ids.length>12||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"||!/^demo-(?:[0-9]|1[01])$/.test(id)))return reply({error:"Demo listings only"},400);
const database=Deno.env.get("SUPABASE_URL");
const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if(!database||!service)return reply({error:"Demo checkout unavailable"},503);
stage="quota";
const quota=await fetch(database+"/rest/v1/rpc/claim_demo_checkout_slot",{
  method:"POST",headers:{apikey:service,Authorization:"Bearer "+service,"Content-Type":"application/json"},body:"{}"
});
if(!quota.ok)return reply({error:"Demo checkout unavailable"},503);
if(await quota.json()!==true)return reply({error:"Demo checkout is busy. Try again shortly."},429);
const items=[["B58 performance downpipe",220],["19-inch M Sport wheels",650],["Civic cold air intake",150],["GR86 lowering springs",180]];
const base="https://leangut36.github.io/Parts-Plug/preview/v85/?demo=1";
const p=new URLSearchParams({mode:"payment",success_url:base+"&stripe=returned",cancel_url:base+"&stripe=cancelled","metadata[demo]":"true"});
if(embedded){p.delete("success_url");p.delete("cancel_url");p.set("ui_mode","embedded");p.set("return_url",base+"&stripe=returned&session_id={CHECKOUT_SESSION_ID}");p.set("billing_address_collection","required");p.set("shipping_address_collection[allowed_countries][0]","US");}ids.forEach((id,i)=>{const n=Number(id.slice(5));const [name,price]=items[n%4];p.set("line_items["+i+"][price_data][currency]","usd");p.set("line_items["+i+"][price_data][product_data][name]","DEMO: "+name);p.set("line_items["+i+"][price_data][unit_amount]",String((Number(price)+Math.floor(n/4)*15)*100));p.set("line_items["+i+"][quantity]","1")});
stage="stripe";
const r=await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/x-www-form-urlencoded"},body:p});
const s=await r.json();
if(!r.ok){
  const error=s?.error;
  const code=[error?.type,error?.code,error?.param].filter(value=>typeof value==="string"&&/^[a-z0-9_\[\]]{1,80}$/i.test(value)).join("/");
  console.error("Stripe demo checkout rejected request",r.status,code);
  if(r.status===401||r.status===403)return reply({error:"Stripe rejected the configured sandbox key"},502);
  return reply({error:"Stripe rejected the demo Checkout Session",diagnostic:code},502);
}
if(embedded){if(!r.ok||s.livemode!==false||typeof s.client_secret!=="string")return reply({error:"Embedded test session failed"},502);return reply({clientSecret:s.client_secret,publishableKey:pk});}if(!r.ok||s.livemode!==false||typeof s.url!=="string"||!s.url.startsWith("https://checkout.stripe.com/"))return reply({error:"Stripe test session creation failed"},502);
return reply({url:s.url});
}catch{
  if(stage==="request")return reply({error:"Invalid checkout request"},400);
  console.error("Demo checkout dependency failed",stage);
  return reply({error:stage==="quota"?"Demo checkout quota service unavailable":"Could not reach Stripe Checkout"},502);
}
});
