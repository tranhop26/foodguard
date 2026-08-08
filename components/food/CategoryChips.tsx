export interface FoodCategory {
  label: string;
  slug: string;
}

interface CategoryChipsProps {
  categories: FoodCategory[];
}

export function CategoryChips({ categories }: CategoryChipsProps) {
  return (
    <nav className="category-nav" aria-label="Danh mục món ăn">
      <a className="category-chip category-chip--active" href="#nha-hang" aria-current="page">
        Tất cả
      </a>
      {categories.map((category) => (
        <a
          className="category-chip"
          href={`/?category=${category.slug}#nha-hang`}
          key={category.slug}
        >
          {category.label}
        </a>
      ))}
    </nav>
  );
}
