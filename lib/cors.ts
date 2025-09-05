// lib/cors.ts
export function withCORS(res: any) {
    // Allow both the storefront and the Theme Editor iframe
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    // If you want to lock it down later, replace '*' with your shop domain.
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  