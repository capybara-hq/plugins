import {
  defineClientExtension,
  defineComponent,
  Spinner,
  Text,
  useLocale,
  useView,
} from "@capybara-hq/plugin-client";

/**
 * Placeholder for the memory page component (`org.page` "memory-page"): it only reports how many
 * memories the server view sent. The directory neural tree page replaces it (plan Task 8).
 */
function MemoryPage() {
  const { view, status } = useView();
  const { t } = useLocale();
  if (status === "loading") return <Spinner />;
  const data = view?.data as { total?: number } | undefined;
  return <Text>{t({ zh: `记忆：${data?.total ?? 0}`, en: `Memories: ${data?.total ?? 0}` })}</Text>;
}

export default defineClientExtension({
  name: "memory",
  components: { "memory-page": defineComponent("org.page", MemoryPage) },
});
