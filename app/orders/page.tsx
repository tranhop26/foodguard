import { OrdersWorkspace } from "../../components/order/RoleConsole";
import { getFoodGuardConfiguration } from "../../lib/genlayer/config";
import { LocaleProvider, type Locale, WorkflowShell } from "../../lib/i18n";

type PageSearchParams = Promise<{ locale?: string | string[] }>;

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const params = await searchParams;
  const rawLocale = firstValue(params.locale);
  const locale: Locale = rawLocale === "en" ? "en" : "vi";
  const configuration = getFoodGuardConfiguration();
  const configurationView =
    configuration.status === "READY"
      ? ({ address: configuration.address, status: "READY", writesEnabled: true } as const)
      : ({
          address: null,
          message: configuration.message,
          status: "DEPLOYMENT_REQUIRED",
          writesEnabled: false,
        } as const);

  return (
    <LocaleProvider hasExplicitLocale={Boolean(rawLocale)} initialLocale={locale}>
      <WorkflowShell page="orders">
        <OrdersWorkspace configuration={configurationView} />
      </WorkflowShell>
    </LocaleProvider>
  );
}
