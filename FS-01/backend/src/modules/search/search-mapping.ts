import type { estypes } from "@elastic/elasticsearch";

// One document per product a shopper can buy: active, in an active category, sold by an approved store.
// Everything a search result card or a filter needs is copied in, so a search never has to ask MongoDB.
export interface ProductSearchDoc {
  id: string;
  title: string;
  // Same text as the title, indexed for prefix matching (autocomplete).
  suggest: string;
  description: string;
  brand: string | null;
  categorySlug: string;
  departmentSlug: string | null;
  categoryName: string;
  // "slug|Name" so filter counts can show names without a lookup.
  categoryFacet: string;
  vendorId: string;
  vendorSlug: string;
  vendorName: string;
  vendorFacet: string;
  price: number;
  mrp: number;
  discountPercent: number;
  ratingAvg: number;
  ratingCount: number;
  stock: number;
  inStock: boolean;
  imageKey: string | null;
  imageAlt: string;
  createdAt: string;
}

// Words shoppers use for the same thing. Applied when products are indexed (so "smartphones" is also stored as
// "phone" and "mobile"), which keeps typo tolerance working at search time. Single words only, plurals listed
// (synonyms run before stemming). Changing this list needs `npm run reindex`.
export const SHOP_SYNONYMS = [
  "phone, phones, smartphone, smartphones, mobile, mobiles, cellphone, cellphones",
  "laptop, laptops, notebook, notebooks",
  "perfume, perfumes, fragrance, fragrances, scent, scents, cologne",
  "tv, tvs, television, televisions",
  "sofa, sofas, couch, couches",
  "headphones, headphone, earphones, earphone, earbuds, headset",
  "watch, watches, wristwatch, wristwatches",
  "sunglasses, shades, goggles",
  "fridge, fridges, refrigerator, refrigerators",
  "bike, bikes, motorcycle, motorcycles, motorbike, motorbikes",
  "car, cars, vehicle, vehicles",
  "dress, dresses, gown, gowns, frock, frocks",
  "tshirt, tshirts, tee, tees",
  "moisturizer, moisturiser, moisturizers, moisturisers, lotion, lotions",
  "sneakers, sneaker, trainers",
  "bag, bags, handbag, handbags, purse, purses",
];

export const INDEX_SETTINGS: estypes.IndicesIndexSettings = {
  number_of_shards: 1,
  // A single node can't hold replicas; one shard is plenty for a few hundred thousand products.
  number_of_replicas: 0,
  analysis: {
    analyzer: {
      // Lower-case and strip accents, so "Café" matches "cafe"; no stemming, so brand and model names stay exact.
      folded: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding"] },
      // For long text: also reduce words to their stem ("phones" → "phone").
      english_folded: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding", "english_possessive", "english_stemmer"] },
      // The same, plus shop synonyms; used when indexing searchable text.
      english_synonyms: {
        type: "custom",
        tokenizer: "standard",
        filter: ["lowercase", "asciifolding", "shop_synonyms", "english_possessive", "english_stemmer"],
      },
    },
    filter: {
      shop_synonyms: { type: "synonym", synonyms: SHOP_SYNONYMS, expand: true },
      english_possessive: { type: "stemmer", language: "possessive_english" },
      english_stemmer: { type: "stemmer", language: "english" },
    },
  },
};

export const INDEX_MAPPINGS: estypes.MappingTypeMapping = {
  dynamic: "strict",
  properties: {
    id: { type: "keyword" },
    // Every word of a query must be found here (typos allowed): title, brand, category and store together,
    // so "samsung phone" matches even though "samsung" is the brand and "phone" the category.
    searchText: { type: "text", analyzer: "english_synonyms", search_analyzer: "english_folded" },
    title: { type: "text", analyzer: "folded", copy_to: "searchText", fields: { stem: { type: "text", analyzer: "english_folded" } } },
    suggest: { type: "search_as_you_type", analyzer: "folded" },
    description: { type: "text", analyzer: "english_synonyms", search_analyzer: "english_folded" },
    brand: { type: "keyword", copy_to: "searchText", fields: { text: { type: "text", analyzer: "folded" } } },
    categorySlug: { type: "keyword" },
    departmentSlug: { type: "keyword" },
    categoryName: { type: "text", analyzer: "english_folded", copy_to: "searchText" },
    categoryFacet: { type: "keyword" },
    vendorId: { type: "keyword" },
    vendorSlug: { type: "keyword" },
    vendorName: { type: "text", analyzer: "folded", copy_to: "searchText" },
    vendorFacet: { type: "keyword" },
    price: { type: "long" },
    mrp: { type: "long" },
    discountPercent: { type: "integer" },
    ratingAvg: { type: "float" },
    ratingCount: { type: "integer" },
    stock: { type: "integer" },
    inStock: { type: "boolean" },
    imageKey: { type: "keyword", index: false },
    imageAlt: { type: "keyword", index: false },
    createdAt: { type: "date" },
  },
};
