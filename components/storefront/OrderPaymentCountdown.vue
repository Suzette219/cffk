<template>
  <span class="flex flex-col gap-1">
    <span v-if="remaining !== null" class="text-xs font-medium tabular-nums text-warning">
      {{ remaining > 0 ? `${messages.orderPayment.remaining} ${countdown}` : messages.orderPayment.expired }}
    </span>
    <template v-if="!compact">
      <span class="text-xs text-muted-foreground">{{ messages.orderPayment.notice }}</span>
      <span v-if="deadlineLabel" class="text-xs text-muted-foreground">{{ messages.orderPayment.deadline }}：{{ deadlineLabel }}</span>
    </template>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ORDER_PAYMENT_TIMEOUT_MS } from "@/lib/order-state";
import { useStorefrontPreferences } from "@/lib/storefront-preferences";
const props = defineProps<{ createdAt: string | Date; compact?: boolean; paused?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const { messages, t } = useStorefrontPreferences();
const now = ref<number | null>(null);
const deadline = computed(() => new Date(props.createdAt).getTime() + ORDER_PAYMENT_TIMEOUT_MS);
const remaining = computed(() => now.value === null || !Number.isFinite(deadline.value) ? null : Math.max(0, Math.ceil((deadline.value - now.value) / 1000)));
const countdown = computed(() => t(messages.value.orderPayment.countdown, { minutes: Math.floor((remaining.value ?? 0) / 60), seconds: ((remaining.value ?? 0) % 60).toString().padStart(2, "0") }));
const deadlineLabel = computed(() => now.value === null || !Number.isFinite(deadline.value) ? "" : new Date(deadline.value).toLocaleString());
let timer: ReturnType<typeof setInterval> | undefined;
let lastRefresh = 0;
function tick() {
  now.value = Date.now();
  if (remaining.value === 0 && now.value - lastRefresh >= 30_000 && !props.paused) {
    lastRefresh = now.value;
    emit("refresh");
  }
}
onMounted(() => { tick(); timer = setInterval(tick, 1000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>
