import { useState } from "react";
import { Link, useParams } from "react-router";
import { MAX_LINE_QTY, useAddToCart } from "../api/cart";
import { useProduct, type Product } from "../api/catalog";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { LoadError, Loading, Price, Rating } from "../components/Catalog";

function AddToCart({ product }: { product: Product }) {
  const { user } = useAuth();
  const add = useAddToCart();
  const [qty, setQty] = useState(1);
  if (user && user.role !== "customer") {
    return <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">Only customer accounts can buy.</p>;
  }
  if (!product.inStock) return null;
  const max = Math.min(MAX_LINE_QTY, product.stock);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Qty
          <select value={qty} onChange={(e) => setQty(Number(e.target.value))} className="rounded-lg border border-slate-300 bg-white px-2 py-2">
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => add.mutate({ productId: product.id, qty })}
          disabled={add.isPending}
          className="rounded-lg bg-brand-600 px-6 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {add.isPending ? "Adding…" : "Add to cart"}
        </button>
      </div>
      {add.isSuccess && (
        <p role="status" className="text-sm text-emerald-700">
          Added to your cart.{" "}
          <Link to="/cart" className="font-medium underline">
            Go to cart
          </Link>
        </p>
      )}
      {add.isError && (
        <p role="alert" className="text-sm text-red-700">
          {add.error instanceof ApiError ? add.error.message : "Couldn't add it to your cart. Try again."}
        </p>
      )}
    </div>
  );
}

export function ProductPage() {
  const { id = "" } = useParams();
  const { data: product, isPending, isError, error } = useProduct(id);
  const [selected, setSelected] = useState(0);

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;

  const image = product.images[selected] ?? product.images[0];
  const specs = Object.entries(product.attributes);

  return (
    <div className="space-y-8">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link to="/" className="hover:text-brand-700">
          Home
        </Link>
        {product.category && (
          <>
            {" / "}
            <Link to={`/?category=${product.category.slug}`} className="hover:text-brand-700">
              {product.category.name}
            </Link>
          </>
        )}
      </nav>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-3">
          <div className="flex aspect-square items-center justify-center rounded-xl border border-slate-200 bg-white">
            {image ? <img src={image.url} alt={image.alt} className="h-full w-full object-contain p-6" /> : <span className="text-slate-400">No photo</span>}
          </div>
          {product.images.length > 1 && (
            <ul className="flex gap-2" aria-label="Photos">
              {product.images.map((img, i) => (
                <li key={img.url}>
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    aria-label={`Show photo ${i + 1}`}
                    aria-pressed={i === selected}
                    className={`h-16 w-16 overflow-hidden rounded-lg border-2 bg-white ${i === selected ? "border-brand-600" : "border-slate-200"}`}
                  >
                    <img src={img.url} alt="" className="h-full w-full object-contain p-1" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-4">
          {product.brand && <p className="text-sm font-medium uppercase tracking-wide text-slate-500">{product.brand}</p>}
          <h1 className="text-2xl font-semibold sm:text-3xl">{product.title}</h1>
          <Rating avg={product.ratingAvg} count={product.ratingCount} />
          <Price price={product.price} mrp={product.mrp} discountPercent={product.discountPercent} large />
          <p className="text-xs text-slate-500">Inclusive of all taxes</p>
          <p className={`text-sm font-medium ${product.inStock ? "text-emerald-700" : "text-red-700"}`}>
            {product.inStock ? (product.stock <= 5 ? `Only ${product.stock} left` : "In stock") : "Out of stock"}
          </p>
          <p className="text-sm text-slate-600">
            Sold by{" "}
            <Link to={`/stores/${product.vendor.slug}`} className="font-medium text-brand-700 underline">
              {product.vendor.storeName}
            </Link>
          </p>
          <AddToCart product={product} />
          {product.description && <p className="whitespace-pre-line text-slate-700">{product.description}</p>}
          {specs.length > 0 && (
            <section>
              <h2 className="mb-2 font-semibold">Specifications</h2>
              <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
                {specs.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-3 gap-2 px-3 py-2">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="col-span-2">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
