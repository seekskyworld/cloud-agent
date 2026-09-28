/** 通用工作台只按公开导航协议装配页面，不理解业务字段。 */
import { useEffect, useMemo, useState, Suspense } from "react";
import { businessViews } from "../../../modules/business-views.js";
import { client, request } from "./api.js";
export function useBusinessPages(token: string) {
  const [pages, setPages] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    let active = true;
    void request<{ id: string; pages: { id: string; title: string }[] }[]>(
      token,
      "/business",
    )
      .then((entries) => {
        if (active)
          setPages(
            entries
              .flatMap((e) =>
                e.pages.map((p) => ({ id: `${e.id}/${p.id}`, title: p.title })),
              )
              .filter((p) => businessViews[p.id]),
          );
      })
      .catch(() => {
        if (active) setPages([]);
      });
    return () => {
      active = false;
    };
  }, [token]);
  return pages;
}
export function BusinessPage({ id, token }: { id: string; token: string }) {
  const api = useMemo(() => client(token), [token]);
  const Component = businessViews[id]?.Component;
  return Component ? (
    <Suspense fallback={<p>正在加载业务页面…</p>}>
      <Component client={api} />
    </Suspense>
  ) : (
    <p role="alert">业务页面不可用。</p>
  );
}
