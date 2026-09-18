<template>
  <div class="flex min-w-0 flex-1 flex-col items-start gap-2">
    <p v-if="proofSubmitted" class="text-sm text-muted-foreground">付款凭证已提交，等待核实。订单不会自动取消。</p>
    <OrderPaymentCountdown v-else :created-at="createdAt" :paused="busy" @refresh="emit('refresh')" />
    <Button v-if="!proofSubmitted" type="button" variant="outline" :disabled="busy || disabled" @click="open = true">{{ messages.orderPayment.cancel }}</Button>
    <Dialog :open="open" @update:open="!busy && (open = $event)">
      <DialogContent :show-close-button="!busy" @interact-outside.prevent @escape-key-down.prevent>
        <DialogHeader><DialogTitle>{{ messages.orderPayment.title }}</DialogTitle><DialogDescription>{{ messages.orderPayment.description }}</DialogDescription></DialogHeader>
        <p class="break-all font-mono text-xs">{{ orderNo }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="open = false">{{ messages.orderPayment.keep }}</Button>
          <Button type="button" variant="destructive" :disabled="busy" @click="cancel">{{ busy ? messages.orderPayment.cancelling : messages.orderPayment.confirm }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import OrderPaymentCountdown from "./OrderPaymentCountdown.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useStorefrontPreferences } from "@/lib/storefront-preferences";
import { runTelefunc } from "@/lib/telefunc-client";
import { onCancelOrder } from "@/server/order/public.telefunc";

const props = defineProps<{ orderNo: string; createdAt: string | Date; email?: string; disabled?: boolean; proofSubmitted?: boolean }>();
const emit = defineEmits<{ cancelled: []; refresh: []; busy: [value: boolean] }>();
const { messages } = useStorefrontPreferences();
const open = ref(false);
const busy = ref(false);
async function cancel() {
  if (busy.value || props.disabled || props.proofSubmitted) return;
  busy.value = true;
  emit("busy", true);
  try {
    await runTelefunc(() => onCancelOrder({ orderNo: props.orderNo, ...(props.email ? { email: props.email } : {}) }), { successMessage: messages.value.orderPayment.cancelled });
    open.value = false;
    emit("cancelled");
  } catch { emit("refresh"); } finally { busy.value = false; emit("busy", false); }
}
</script>
