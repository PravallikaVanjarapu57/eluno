import { z } from "zod";

// Only the fields the till reads. Unknown fields pass through untouched; missing ones fail loudly.

export const ShopifyCustomerSchema = z.object({
  id: z.number().int(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable().optional(),
  tags: z.string(),
  total_spent: z.string(),
  orders_count: z.number().int(),
});
export const CustomerResponseSchema = z.object({ customer: ShopifyCustomerSchema });
export const CustomerSearchResponseSchema = z.object({ customers: z.array(ShopifyCustomerSchema) });

const FrameMetaSchema = z.object({
  line_type: z.literal("frame"),
  hsn: z.string(),
  category: z.enum(["optical", "sunglasses"]),
  rx_able: z.boolean(),
});

const LensMetaSchema = z.object({
  line_type: z.literal("lens"),
  hsn: z.string(),
  lens_type: z.enum(["single_vision", "bifocal", "progressive"]),
  index: z.number().positive(),
  coating: z.string(),
  rx_limits: z.object({
    sph_min: z.number(),
    sph_max: z.number(),
    cyl_abs_max: z.number().nonnegative(),
    add_required: z.boolean(),
    add_min: z.number(),
    add_max: z.number(),
  }),
  lab_tat_days: z.number().int().nonnegative(),
});

export const ShopifyVariantSchema = z.object({
  id: z.number().int(),
  product_id: z.number().int(),
  sku: z.string(),
  title: z.string(),
  price: z.string(),
  inventory_item_id: z.number().int().nullable(),
  eluno: z.discriminatedUnion("line_type", [FrameMetaSchema, LensMetaSchema]),
});

export const ShopifyProductSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  product_type: z.string(),
  status: z.enum(["active", "archived", "draft"]),
  variants: z.array(ShopifyVariantSchema),
});
export const ProductsResponseSchema = z.object({ products: z.array(ShopifyProductSchema) });
export const ProductResponseSchema = z.object({ product: ShopifyProductSchema });
export const VariantResponseSchema = z.object({ variant: ShopifyVariantSchema });

export const ShopifyLocationSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  eluno: z.object({
    store_code: z.string(),
    invoice_prefix: z.string().nullable(), // null for HQ, which never bills
    state_code: z.string(),
    kind: z.string(),
  }),
});
export const LocationsResponseSchema = z.object({ locations: z.array(ShopifyLocationSchema) });

export const InventoryLevelsResponseSchema = z.object({
  inventory_levels: z.array(z.object({ inventory_item_id: z.number().int(), location_id: z.number().int(), available: z.number().int() })),
});

export type ShopifyCustomer = z.infer<typeof ShopifyCustomerSchema>;
export type ShopifyVariant = z.infer<typeof ShopifyVariantSchema>;
export type ShopifyProduct = z.infer<typeof ShopifyProductSchema>;
export type ShopifyLocation = z.infer<typeof ShopifyLocationSchema>;

const NameValue = z.object({ name: z.string(), value: z.string() });

const ShopifyRefundSchema = z.object({
  id: z.number().int(),
  created_at: z.string(),
  note_attributes: z.array(NameValue).default([]),
  refund_line_items: z.array(z.object({ line_item_id: z.number().int(), quantity: z.number().int(), restock_type: z.string(), subtotal: z.string(), total_tax: z.string() })),
  transactions: z.array(z.object({ id: z.number().int().optional(), kind: z.string(), amount: z.string(), gateway: z.string().nullable().optional() })),
});

export const ShopifyOrderSchema = z.object({
  id: z.number().int(),
  order_number: z.number().int(),
  name: z.string(),
  created_at: z.string(),
  location_id: z.number().int().nullable(),
  financial_status: z.string(),
  total_price: z.string(),
  total_tax: z.string(),
  total_discounts: z.string(),
  subtotal_price: z.string(),
  note_attributes: z.array(NameValue),
  line_items: z.array(
    z.object({
      id: z.number().int(),
      variant_id: z.number().int(),
      sku: z.string(),
      quantity: z.number().int(),
      price: z.string(),
      total_discount: z.string(),
      tax_lines: z.array(z.object({ title: z.string(), rate: z.number(), price: z.string() })),
      properties: z.array(NameValue),
    }),
  ),
  transactions: z.array(z.object({ id: z.number().int(), kind: z.string(), status: z.string(), amount: z.string(), gateway: z.string().nullable().optional() })),
  cancelled_at: z.string().nullable().optional(),
  discount_applications: z.array(z.object({ title: z.string(), value: z.string() })).default([]),
  refunds: z.array(ShopifyRefundSchema),
});
export const OrderResponseSchema = z.object({ order: ShopifyOrderSchema });
export const OrdersResponseSchema = z.object({ orders: z.array(ShopifyOrderSchema) });
export type ShopifyOrder = z.infer<typeof ShopifyOrderSchema>;

export const RefundCalculateResponseSchema = z.object({
  refund: z.object({
    refund_line_items: z.array(z.object({ line_item_id: z.number().int(), subtotal: z.string(), total_tax: z.string() })),
    transactions: z.array(z.object({ maximum_refundable: z.string().optional() })),
  }),
});

export const RefundResponseSchema = z.object({ refund: ShopifyRefundSchema });
export const OrderWithRefundsSchema = z.object({ order: z.object({ id: z.number().int(), refunds: z.array(ShopifyRefundSchema) }) });
export type ShopifyRefund = z.infer<typeof ShopifyRefundSchema>;
