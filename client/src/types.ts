/** Shared client contracts for the Coffee SaaS API. */
export type UserRole = 'owner' | 'manager' | 'cashier' | 'staff';
export type PlanId = 'free' | 'basic' | 'premium';
export type PaymentMethod = 'cash' | 'gcash' | 'maya' | 'card';
export type OrderType = 'standard' | 'dine_in' | 'takeout' | 'delivery';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ShopUser { id: string; name: string; email: string; }
export interface Workspace { id: string; name: string; role: UserRole; business_type?: 'food' | 'non_food'; modules?: Record<string, boolean>; branch_ids?: string[] | null; }
export interface AuthPayload { email?: string; password?: string; name?: string; shopName?: string; plan?: PlanId | string; token?: string | null; [key: string]: unknown; }
export interface ApiRequest { (path: string, method?: HttpMethod | string, body?: unknown, admin?: boolean, signal?: AbortSignal): Promise<any>; }
export interface Category { id: string; name: string; }
export interface ProductVariation { id: string; name: string; price_delta_cents?: number; }
export interface AddOn { id: string; name: string; price_cents: number; }
export interface Product { id: string; name: string; price_cents: number; category_id?: string; category_name?: string; active?: boolean; variations?: ProductVariation[]; }
export interface Branch { id: string; tenant_id: string; name: string; active: boolean; }
export interface CartLine { product_id: string; quantity: number; variation_id?: string | null; addon_ids?: string[]; }
export interface ReceiptItem { name: string; variation?: string; quantity: number; total_cents: number; }
export interface SaleReceipt { order_number: number | string; created_at: string; order_type: OrderType; items: ReceiptItem[]; subtotal_cents: number; discount_cents: number; tax_cents: number; service_cents: number; total_cents: number; payment_method: PaymentMethod; change_cents?: number; }
