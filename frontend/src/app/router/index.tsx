import { BrowserRouter, Routes, Route } from 'react-router-dom';

function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
      <div className="max-w-2xl bg-white rounded-2xl shadow-sm border border-stone-200 p-8">
        <h1 className="text-3xl font-bold tracking-tight text-stone-900 mb-3">
          vCraft — Tinh hoa làng gốm Bát Tràng
        </h1>
        <p className="text-stone-600 mb-6">
          Nền tảng triển lãm số, truy xuất nguồn gốc và điều phối đơn mua buôn.
        </p>
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 text-emerald-700 text-sm font-medium rounded-full border border-emerald-200">
          <span>●</span> Hệ thống Frontend & Backend đã sẵn sàng khởi động
        </div>
      </div>
    </div>
  );
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  );
}
