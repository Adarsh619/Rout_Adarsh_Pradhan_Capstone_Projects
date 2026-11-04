// What the demo catalogue looks like: the snapshot format, the category tree, the five stores and how
// source prices become rupees. Used by fetch-catalog-snapshot.ts and seed-catalog.ts.

// seed/catalog.json, next to package.json (works from src/scripts with tsx and from dist/scripts in Docker).
export const CATALOG_SNAPSHOT = new URL("../../seed/catalog.json", import.meta.url);

export interface SnapshotProduct {
  source: "dummyjson" | "fakestore";
  sourceId: number;
  title: string;
  description: string;
  brand: string | null;
  sourceCategory: string;
  priceUsd: number;
  discountPercent: number;
  stock: number;
  rating: number;
  ratingCount: number;
  images: string[];
  attributes: Record<string, string>;
  reviews: { rating: number; comment: string; date: string; reviewerName: string }[];
}

// Department → sub-category → the source categories that land in it.
export const CATEGORY_TREE: { name: string; children: { name: string; from: string[] }[] }[] = [
  {
    name: "Electronics",
    children: [
      { name: "Smartphones", from: ["smartphones"] },
      { name: "Laptops", from: ["laptops"] },
      { name: "Tablets", from: ["tablets"] },
      { name: "Mobile Accessories", from: ["mobile-accessories", "electronics"] },
    ],
  },
  {
    name: "Fashion",
    children: [
      { name: "Men's Clothing", from: ["mens-shirts", "men's clothing"] },
      { name: "Women's Clothing", from: ["womens-dresses", "tops", "women's clothing"] },
      { name: "Footwear", from: ["mens-shoes", "womens-shoes"] },
      { name: "Watches", from: ["mens-watches", "womens-watches"] },
      { name: "Bags & Jewellery", from: ["womens-bags", "womens-jewellery", "jewelery"] },
      { name: "Sunglasses", from: ["sunglasses"] },
    ],
  },
  {
    name: "Home & Kitchen",
    children: [
      { name: "Furniture", from: ["furniture"] },
      { name: "Home Decor", from: ["home-decoration"] },
      { name: "Kitchen", from: ["kitchen-accessories"] },
    ],
  },
  {
    name: "Beauty & Personal Care",
    children: [
      { name: "Makeup", from: ["beauty"] },
      { name: "Fragrances", from: ["fragrances"] },
      { name: "Skin Care", from: ["skin-care"] },
    ],
  },
  { name: "Grocery", children: [{ name: "Fresh & Packaged Food", from: ["groceries"] }] },
  { name: "Sports & Outdoors", children: [{ name: "Sports Equipment", from: ["sports-accessories"] }] },
  {
    name: "Automotive",
    children: [
      { name: "Cars", from: ["vehicle"] },
      { name: "Motorcycles", from: ["motorcycle"] },
    ],
  },
];

// Five approved stores (the first is the demo vendor account) and one application waiting for the admin.
export const SEED_STORES: {
  owner: { name: string; email: string };
  storeName: string;
  description: string;
  phone: string;
  gstin?: string;
  status: "approved" | "pending";
  sells: string[];
}[] = [
  {
    owner: { name: "Vikram Vendor", email: "vendor@shopsphere.test" },
    storeName: "Vikram Electronics",
    description: "Phones, laptops, tablets and accessories with GST invoices and brand warranty.",
    phone: "9876543210",
    gstin: "29ABCDE1234F1Z5",
    status: "approved",
    sells: ["smartphones", "laptops", "tablets", "mobile-accessories", "electronics"],
  },
  {
    owner: { name: "Meera Kapoor", email: "meera@shopsphere.test" },
    storeName: "Meera Fashion House",
    description: "Clothing, footwear, watches and accessories for men and women.",
    phone: "9811122233",
    gstin: "07AAACM1234K1Z2",
    status: "approved",
    sells: [
      "mens-shirts", "men's clothing", "womens-dresses", "tops", "women's clothing", "mens-shoes", "womens-shoes",
      "mens-watches", "womens-watches", "womens-bags", "womens-jewellery", "jewelery", "sunglasses",
    ],
  },
  {
    owner: { name: "Arjun Nair", email: "arjun@shopsphere.test" },
    storeName: "Ghar Living",
    description: "Furniture, decor and kitchenware for every home.",
    phone: "9447012345",
    status: "approved",
    sells: ["furniture", "home-decoration", "kitchen-accessories"],
  },
  {
    owner: { name: "Sana Sheikh", email: "sana@shopsphere.test" },
    storeName: "Daily Fresh & Care",
    description: "Groceries, makeup, fragrances and skin care, delivered fresh.",
    phone: "9820098200",
    status: "approved",
    sells: ["groceries", "beauty", "fragrances", "skin-care"],
  },
  {
    owner: { name: "Rohan Singh", email: "rohan@shopsphere.test" },
    storeName: "Velocity Sports & Motors",
    description: "Sports equipment, cars and motorcycles.",
    phone: "9876501234",
    status: "approved",
    sells: ["sports-accessories", "vehicle", "motorcycle"],
  },
  {
    owner: { name: "Kavya Iyer", email: "kavya@shopsphere.test" },
    storeName: "Kavya Handicrafts",
    description: "Handmade brass, pottery and textiles from Tamil Nadu artisans.",
    phone: "9840011223",
    status: "pending",
    sells: [],
  },
];

const USD_TO_INR = 85;

// Rupee prices that look like real Indian listings: ₹99, ₹1,499, ₹24,999 …
export function toRupeePrice(usd: number): number {
  const rupees = usd * USD_TO_INR;
  const step = rupees < 1000 ? 10 : rupees < 10_000 ? 100 : 1000;
  return Math.max(99, Math.ceil(rupees / step) * step - 1);
}

// Price and MRP in paise. The MRP undoes the source's discount, rounded the same way, never below the price.
export function seedPrices(p: Pick<SnapshotProduct, "priceUsd" | "discountPercent">): { price: number; mrp: number } {
  const price = toRupeePrice(p.priceUsd);
  const mrp = p.discountPercent > 1 ? Math.max(price, toRupeePrice(p.priceUsd / (1 - p.discountPercent / 100))) : price;
  return { price: price * 100, mrp: mrp * 100 };
}
