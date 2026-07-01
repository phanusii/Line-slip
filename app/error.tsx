"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="page errorRecoveryPage">
      <section className="panel errorRecoveryPanel">
        <span className="badge danger">ข้อผิดพลาด</span>
        <h1>หน้าเว็บสะดุดชั่วคราว</h1>
        <p className="muted">
          ระบบยังทำงานอยู่ กรุณากดลองโหลดใหม่อีกครั้ง หากเกิดจากฐานข้อมูลหรือเครือข่ายสะดุด หน้าเว็บจะกลับมาเอง
        </p>
        <div className="actions">
          <button className="btn primary" onClick={reset}>
            ลองโหลดใหม่
          </button>
          <button className="btn subtle" onClick={() => window.location.reload()}>
            รีเฟรชหน้าเว็บ
          </button>
        </div>
      </section>
    </main>
  );
}
