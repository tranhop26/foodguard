import Image from "next/image";

interface HeroProps {
  contractReady: boolean;
  searchQuery?: string;
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

export function Hero({ contractReady, searchQuery = "" }: HeroProps) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero__media">
        <Image
          src="/images/foodguard/hero-marketplace.webp"
          alt="Bàn món Việt với phở, bánh xèo và cuốn tươi"
          fill
          priority
          sizes="(max-width: 767px) 100vw, (max-width: 1439px) 94vw, 1320px"
        />
      </div>
      <div className="hero__veil" aria-hidden="true" />

      <div className="hero__content">
        <div className="network-badge">
          <span className="network-badge__mark" aria-hidden="true">S</span>
          <span>StudioNet · Simulated GEN</span>
        </div>

        <p className="eyebrow">Marketplace có lớp kiểm chứng</p>
        <h1 id="hero-title">Món ngon đến cửa, bằng chứng đi cùng.</h1>
        <p className="hero__lede">
          Chọn món Việt từ catalog demo, xem trước cam kết món ăn và hiểu cách
          bằng chứng công khai có thể đi cùng từng đơn.
        </p>

        <form className="hero-search" role="search" action="/#nha-hang">
          <label className="sr-only" htmlFor="marketplace-search">
            Tìm món ăn hoặc nhà hàng
          </label>
          <span className="hero-search__icon"><SearchIcon /></span>
          <input
            id="marketplace-search"
            name="q"
            type="search"
            defaultValue={searchQuery}
            placeholder="Tìm phở, cơm nhà, món chay…"
          />
          <button type="submit">Tìm món</button>
        </form>

        <div className="hero__actions">
          <a className="button button--primary" href="#nha-hang">
            Khám phá 6 nhà hàng
            <span aria-hidden="true">↓</span>
          </a>
          {contractReady ? (
            <a className="button button--quiet" href="/create">
              Tạo đơn qua hợp đồng
            </a>
          ) : (
            <button className="button button--quiet" type="button" disabled>
              Tạo đơn qua hợp đồng
            </button>
          )}
        </div>

        {!contractReady && (
          <p className="deployment-note" role="status">
            <span aria-hidden="true">!</span>
            Chưa triển khai contract trên StudioNet — khám phá vẫn sẵn sàng,
            thao tác hợp đồng đang khóa.
          </p>
        )}
      </div>
    </section>
  );
}
