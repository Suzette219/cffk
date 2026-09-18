<template>
  <div class="w-full text-left">
    <Alert v-if="submitted || proof">
      <AlertTitle>付款凭证已提交，等待核实</AlertTitle>
      <AlertDescription>请勿重复付款。核实到账后将更新订单状态，等待期间订单不会自动取消。</AlertDescription>
    </Alert>
    <Button v-else class="w-full" :disabled="disabled" @click="open = true">我已完成付款</Button>
    <Dialog :open="open" @update:open="!busy && (open = $event)">
      <DialogContent class="max-h-[90dvh] overflow-y-auto" :show-close-button="!busy" @interact-outside="busy && $event.preventDefault()" @escape-key-down="busy && $event.preventDefault()">
        <DialogHeader><DialogTitle>提交付款凭证</DialogTitle><DialogDescription>填写支付宝交易订单号或上传付款成功截图，至少提供一项。</DialogDescription></DialogHeader>
        <form class="flex flex-col gap-5" @submit.prevent="submit">
          <FieldGroup>
            <Field :data-invalid="Boolean(error)">
              <FieldLabel for="proof-transaction">支付宝交易订单号</FieldLabel>
              <Input id="proof-transaction" v-model="transactionNo" inputmode="numeric" autocomplete="off" :maxlength="64" :disabled="busy" :aria-invalid="Boolean(error)" aria-describedby="proof-transaction-help" />
              <FieldDescription id="proof-transaction-help">打开支付宝 → 账单 → 对应付款详情，复制交易订单号（不是商城订单号）。</FieldDescription>
            </Field>
            <Field :data-invalid="Boolean(error)">
              <FieldLabel for="proof-image">付款成功截图</FieldLabel>
              <Input id="proof-image" type="file" accept="image/jpeg,image/png,image/webp" :disabled="busy" @change="selectImage" />
              <FieldDescription>支持 JPG、PNG、WebP，原图不超过 8 MB。请保留付款金额、时间和交易订单号。</FieldDescription>
              <p v-if="processing" class="text-sm text-muted-foreground">正在处理截图...</p>
              <template v-if="screenshot"><img :src="screenshot" alt="付款凭证预览" class="max-h-72 max-w-full object-contain" /><Button type="button" variant="outline" :disabled="busy" @click="removeImage">移除截图</Button></template>
            </Field>
            <FieldError v-if="error">{{ error }}</FieldError>
          </FieldGroup>
          <DialogFooter><Button type="button" variant="outline" :disabled="busy" @click="open = false">返回</Button><Button type="submit" :disabled="busy || disabled">{{ submitting ? '正在提交...' : '提交付款凭证' }}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ALIPAY_TRANSACTION_NO_PATTERN, PAYMENT_PROOF_MAX_BYTES, type PaymentProofSummary } from "@/lib/payment-proof";
import { runTelefunc, userErrorMessage } from "@/lib/telefunc-client";
import { onSubmitPaymentProof } from "@/server/order/public.telefunc";

const props = defineProps<{ orderNo: string; email?: string; proof?: PaymentProofSummary | null; disabled?: boolean }>();
const emit = defineEmits<{ submitted: []; busy: [value: boolean] }>();
const open = ref(false), processing = ref(false), submitting = ref(false), submitted = ref(false);
const busy = computed(() => processing.value || submitting.value);
const transactionNo = ref(""), screenshot = ref(""), error = ref("");
function removeImage() {
  screenshot.value = "";
  const input = document.getElementById("proof-image") as HTMLInputElement | null;
  if (input) input.value = "";
}
async function selectImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  screenshot.value = "";
  error.value = "";
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) { error.value = "请选择不超过 8 MB 的 JPG、PNG 或 WebP 图片。"; input.value = ""; return; }
  processing.value = true;
  emit("busy", true);
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error("image dimensions");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.startsWith("data:image/jpeg;base64,") && atob(data.slice(23)).length <= PAYMENT_PROOF_MAX_BYTES) { screenshot.value = data; return; }
    }
    error.value = "图片内容过大，请裁剪到付款详情后重新上传，或填写支付宝交易订单号。";
    input.value = "";
  } catch { error.value = "无法读取图片，请重新选择付款截图，或填写支付宝交易订单号。"; input.value = ""; }
  finally { bitmap?.close(); processing.value = false; emit("busy", false); }
}
async function submit() {
  if (busy.value || props.disabled) return;
  error.value = "";
  const number = transactionNo.value.trim();
  if (!number && !screenshot.value) { error.value = "请填写支付宝交易订单号或上传付款成功截图，至少提供一项。"; return; }
  if (number && !ALIPAY_TRANSACTION_NO_PATTERN.test(number)) { error.value = "支付宝交易订单号应为 20–64 位数字，请从支付宝账单详情复制。"; return; }
  submitting.value = true;
  emit("busy", true);
  try {
    await runTelefunc(() => onSubmitPaymentProof({ orderNo: props.orderNo, email: props.email, transactionNo: number || undefined, screenshot: screenshot.value || undefined }), { notifyError: false });
    submitted.value = true;
    open.value = false;
    screenshot.value = "";
    emit("submitted");
  } catch (cause) { error.value = userErrorMessage(cause, "付款凭证提交失败，请稍后重试。"); }
  finally { submitting.value = false; emit("busy", false); }
}
</script>
