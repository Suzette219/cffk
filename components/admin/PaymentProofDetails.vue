<template>
  <div v-if="proof" class="flex flex-col gap-3 text-sm">
    <p class="text-muted-foreground">提交时间：{{ formatDateInTimezone(proof.createdAt, timezone) }}</p>
    <p v-if="proof.transactionNo" class="break-all">支付宝交易订单号：<span class="font-mono">{{ proof.transactionNo }}</span></p>
    <template v-if="proof.screenshot">
      <p>付款成功截图（可滚动查看原图）</p>
      <div class="max-h-80 overflow-auto rounded-md border"><img :src="proof.screenshot" alt="买家提交的付款成功截图" class="max-w-none" /></div>
    </template>
    <p class="text-muted-foreground">凭证由买家提供，请在支付宝账单中核对真实到账金额及交易订单号后确认。</p>
  </div>
  <p v-else class="text-sm text-muted-foreground">买家尚未提交付款凭证。</p>
</template>
<script setup lang="ts">
import { formatDateInTimezone, useSiteTimezone } from "@/lib/site-timezone";
const timezone = useSiteTimezone();
defineProps<{ proof: { transactionNo: string | null; screenshot: string | null; createdAt: Date } | null }>();
</script>
