export interface FoodCategory {
  catalogValue: string;
  label: string;
  slug: string;
}

interface CategoryChipsProps {
  activeSlug?: string;
  categories: FoodCategory[];
  searchQuery?: string;
}

function categoryHref(slug: string | undefined, searchQuery: string): string {
  const params = new URLSearchParams();
  if (searchQuery) params.set("q", searchQuery);
  if (slug) params.set("category", slug);
  const query = params.toString();
  return `/${query ? `?${query}` : ""}#nha-hang`;
}

export function CategoryChips({
  activeSlug,
  categories,
  searchQuery = "",
}: CategoryChipsProps) {
  return (
    <nav className="category-nav" aria-label="Danh mục món ăn">
      <a
        className={`category-chip${activeSlug ? "" : " category-chip--active"}`}
        href={categoryHref(undefined, searchQuery)}
        aria-current={activeSlug ? undefined : "page"}
      >
        Tất cả
      </a>
      {categories.map((category) => (
        <a
          aria-current={activeSlug === category.slug ? "page" : undefined}
          className={`category-chip${activeSlug === category.slug ? " category-chip--active" : ""}`}
          href={categoryHref(category.slug, searchQuery)}
          key={category.slug}
        >
          {category.label}
        </a>
      ))}
    </nav>
  );
}
