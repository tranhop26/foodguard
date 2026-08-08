import catalogData from "../public/catalog/catalog-v1.json";
import { CategoryChips, type FoodCategory } from "../components/food/CategoryChips";
import { Hero } from "../components/food/Hero";
import { ProofStrip } from "../components/food/ProofStrip";
import { RestaurantCard } from "../components/food/RestaurantCard";
import type { Restaurant } from "../lib/domain";
import {
  getFoodGuardConfiguration,
  type FoodGuardConfiguration,
} from "../lib/genlayer/config";

const categories: FoodCategory[] = [
  { catalogValue: "Cơm Việt", label: "Cơm Việt", slug: "com-viet" },
  { catalogValue: "Món nước", label: "Món nước", slug: "mon-nuoc" },
  { catalogValue: "Món chay", label: "Món chay", slug: "mon-chay" },
  { catalogValue: "Cuốn & gỏi", label: "Cuốn & gỏi", slug: "cuon-goi" },
  { catalogValue: "Bánh mì", label: "Bánh mì", slug: "banh-mi" },
];

const restaurants = catalogData.restaurants as Restaurant[];

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/giu, "d")
    .toLocaleLowerCase("vi")
    .trim();
}

function filterRestaurants(searchQuery: string, categorySlug: string): Restaurant[] {
  const normalizedQuery = normalizeSearch(searchQuery);
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  const selectedCategory = categories.find((category) => category.slug === categorySlug);

  return restaurants.filter((restaurant) => {
    const matchesCategory = selectedCategory
      ? restaurant.categories.includes(selectedCategory.catalogValue)
      : true;
    const searchable = normalizeSearch(
      [
        restaurant.name,
        restaurant.description,
        restaurant.neighborhood,
        ...restaurant.categories,
        restaurant.featured_item.name,
        ...restaurant.featured_item.conditions,
      ].join(" "),
    );
    const searchableTerms = searchable.split(/[^a-z0-9]+/).filter(Boolean);
    const matchesQuery = queryTerms.every((queryTerm) =>
      searchableTerms.some(
        (searchableTerm) =>
          searchableTerm === queryTerm ||
          (queryTerm.length >= 4 && searchableTerm.startsWith(queryTerm)),
      ),
    );
    return matchesCategory && matchesQuery;
  });
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 36" width="24" height="27">
        <path d="M16 2 29 7v9c0 8.2-5.1 14.4-13 18C8.1 30.4 3 24.2 3 16V7L16 2Z" fill="currentColor" />
        <path d="m10.2 17.4 3.7 3.7 7.9-8.2" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.7" />
      </svg>
    </span>
  );
}

function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="brand" href="/" aria-label="FoodGuard — trang chủ">
          <BrandMark />
          <span>FoodGuard</span>
        </a>

        <nav className="site-nav" aria-label="Điều hướng chính">
          <a href="#nha-hang">Khám phá</a>
          <a href="#bang-chung">Cách hoạt động</a>
        </nav>

        <div className="language-ready" aria-label="Ngôn ngữ mặc định: Tiếng Việt">
          <span className="language-ready__active">VI</span>
          <span aria-hidden="true">/</span>
          <span lang="en" title="English-ready">EN</span>
        </div>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <a className="brand brand--footer" href="/" aria-label="FoodGuard — trang chủ">
          <BrandMark />
          <span>FoodGuard</span>
        </a>
        <p>Catalog demo · Bằng chứng công khai · Không lưu khóa riêng.</p>
        <p>StudioNet · Simulated GEN only</p>
      </div>
    </footer>
  );
}

interface LandingPageProps {
  categorySlug?: string;
  configuration: FoodGuardConfiguration;
  searchQuery?: string;
}

export function LandingPage({
  categorySlug = "",
  configuration,
  searchQuery = "",
}: LandingPageProps) {
  const selectedCategory = categories.find((category) => category.slug === categorySlug);
  const visibleRestaurants = filterRestaurants(searchQuery, categorySlug);
  const hasFilters = Boolean(searchQuery.trim() || selectedCategory);

  return (
    <div className="page-shell">
      <a className="skip-link" href="#main-content">Bỏ qua đến nội dung chính</a>
      <SiteHeader />
      <main id="main-content">
        <Hero
          contractReady={configuration.status === "READY"}
          searchQuery={searchQuery}
        />

        <div id="bang-chung" className="section-wrap section-wrap--proof">
          <ProofStrip />
        </div>

        <section className="restaurant-section" id="nha-hang" aria-labelledby="restaurants-title">
          <div className="restaurant-section__heading">
            <div>
              <p className="eyebrow">Catalog demo · Phiên bản 1</p>
              <h2 id="restaurants-title">Quán Việt đáng để mở thực đơn</h2>
            </div>
            <p aria-live="polite">
              {hasFilters
                ? `${visibleRestaurants.length} nhà hàng phù hợp với bộ lọc hiện tại.`
                : "Sáu hồ sơ minh họa, mỗi món có dữ liệu đủ để tạo manifest ở bước đặt hàng."}
            </p>
          </div>

          <CategoryChips
            activeSlug={selectedCategory?.slug}
            categories={categories}
            searchQuery={searchQuery}
          />

          <div className="restaurant-grid" aria-label="Kết quả nhà hàng">
            {visibleRestaurants.map((restaurant, index) => (
              <RestaurantCard
                eager={hasFilters && index === 0}
                restaurant={restaurant}
                key={restaurant.restaurant_id}
              />
            ))}
          </div>
          {visibleRestaurants.length === 0 && (
            <div className="empty-results" role="status">
              <h3>Chưa tìm thấy món phù hợp</h3>
              <p>Thử từ khóa ngắn hơn hoặc quay lại danh mục “Tất cả”.</p>
            </div>
          )}
        </section>

        <section className="closing-note" aria-labelledby="closing-title">
          <p className="eyebrow eyebrow--light">Rõ giới hạn trước khi bắt đầu</p>
          <div className="closing-note__body">
            <h2 id="closing-title">Khám phá món trước. Tin bằng chứng sau khi kiểm tra.</h2>
            <p>
              FoodGuard không thay nhà hàng, courier hay validator bằng một nhãn “đã xác minh”.
              Nó minh họa cách giữ nguyên cam kết, theo dõi bằng chứng và chỉ hiển thị kết quả
              sau khi contract đọc lại trạng thái.
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

type PageSearchParams = Promise<{
  category?: string | string[];
  q?: string | string[];
}>;

function firstSearchValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function HomePage({ searchParams }: { searchParams: PageSearchParams }) {
  const params = await searchParams;
  return (
    <LandingPage
      categorySlug={firstSearchValue(params.category)}
      configuration={getFoodGuardConfiguration()}
      searchQuery={firstSearchValue(params.q)}
    />
  );
}
