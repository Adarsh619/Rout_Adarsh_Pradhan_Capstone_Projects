import type { ReactNode } from "react";
import { Route, Routes } from "react-router";
import { RequireAuth } from "./auth/RequireAuth";
import type { Role } from "./auth/types";
import { Layout } from "./components/Layout";
import { AccountPage } from "./pages/AccountPage";
import { CartPage } from "./pages/CartPage";
import { CouponsPage } from "./pages/CouponsPage";
import { CheckoutPage } from "./pages/CheckoutPage";
import { OrderPage } from "./pages/OrderPage";
import { OrdersPage } from "./pages/OrdersPage";
import { VendorEarningsPage } from "./pages/vendor/VendorEarningsPage";
import { VendorOrdersPage } from "./pages/vendor/VendorOrdersPage";
import { AdminCategoriesPage } from "./pages/admin/AdminCategoriesPage";
import { AdminAnalyticsPage } from "./pages/admin/AdminAnalyticsPage";
import { AdminDashboard } from "./pages/admin/AdminDashboard";
import { AdminOrdersPage } from "./pages/admin/AdminOrdersPage";
import { AdminReviewsPage } from "./pages/admin/AdminReviewsPage";
import { AdminVendorsPage } from "./pages/admin/AdminVendorsPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProductPage } from "./pages/ProductPage";
import { RegisterPage } from "./pages/RegisterPage";
import { SearchPage } from "./pages/SearchPage";
import { StorePage } from "./pages/StorePage";
import { ProductEditorPage } from "./pages/vendor/ProductEditorPage";
import { VendorDashboard } from "./pages/vendor/VendorDashboard";
import { VendorProductsPage } from "./pages/vendor/VendorProductsPage";

const only = (roles: Role[] | undefined, page: ReactNode) => <RequireAuth roles={roles}>{page}</RequireAuth>;

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="products/:id" element={<ProductPage />} />
        <Route path="stores/:slug" element={<StorePage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="account" element={only(undefined, <AccountPage />)} />
        <Route path="cart" element={<CartPage />} />
        <Route path="checkout" element={only(["customer"], <CheckoutPage />)} />
        <Route path="orders" element={only(["customer"], <OrdersPage />)} />
        <Route path="orders/:id" element={only(["customer"], <OrderPage />)} />

        <Route path="vendor" element={only(["vendor"], <VendorDashboard />)} />
        <Route path="vendor/products" element={only(["vendor"], <VendorProductsPage />)} />
        <Route path="vendor/products/new" element={only(["vendor"], <ProductEditorPage />)} />
        <Route path="vendor/products/:id" element={only(["vendor"], <ProductEditorPage />)} />
        <Route path="vendor/orders" element={only(["vendor"], <VendorOrdersPage />)} />
        <Route path="vendor/coupons" element={only(["vendor"], <CouponsPage owner="vendor" />)} />
        <Route path="vendor/earnings" element={only(["vendor"], <VendorEarningsPage />)} />

        <Route path="admin" element={only(["admin"], <AdminDashboard />)} />
        <Route path="admin/vendors" element={only(["admin"], <AdminVendorsPage />)} />
        <Route path="admin/categories" element={only(["admin"], <AdminCategoriesPage />)} />
        <Route path="admin/coupons" element={only(["admin"], <CouponsPage owner="admin" />)} />
        <Route path="admin/analytics" element={only(["admin"], <AdminAnalyticsPage />)} />
        <Route path="admin/orders" element={only(["admin"], <AdminOrdersPage />)} />
        <Route path="admin/reviews" element={only(["admin"], <AdminReviewsPage />)} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
