<script setup lang="ts">
/*
 * UiButton — base button primitive per Claude Design hi-fi.
 *
 * Kind: primary (Harmony fill) · secondary (white with border) ·
 * ghost (transparent) · cta (Hustle fill — reserved for sign-in).
 * Size: sm | md (default) | lg.
 *
 * When `to` is passed, renders a <NuxtLink> with the same class shape
 * instead of a <button>. Use this for primary actions that navigate
 * (e.g. inbox drawer "Add top-up" link). Mutually exclusive with
 * `type`/`@click` for native button semantics.
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    kind?: 'primary' | 'secondary' | 'ghost' | 'cta'
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    to?: string
  }>(),
  {
    kind: 'secondary',
    size: 'md',
    type: 'button',
    to: undefined,
  },
)

const buttonClass = computed(() => [
  // Disabled = an explicit, readable grey (NOT opacity on the kind colour,
  // which rendered as unreadable light-purple-on-light-purple for the primary /
  // cta fills). The disabled: pseudo-class utilities override the kind bg/text.
  //
  // Focus: a 2px harmony ring offset 2px on keyboard focus (WCAG 2.4.7). It
  // matches the global :focus-visible rule in main.css, written here so the
  // primitive does not depend on that rule surviving; on the primary fill the
  // 2px gap of page background keeps the ring distinct from the button.
  'inline-flex items-center gap-2 rounded-lg font-bold tracking-tight whitespace-nowrap border border-transparent no-underline hover:no-underline transition-[background-color,border-color,color,box-shadow] duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-harmony disabled:cursor-not-allowed disabled:bg-calm-2 disabled:text-carbon-3 disabled:border-transparent disabled:shadow-none',
  props.size === 'sm' && 'px-3 py-1.5 text-xs',
  props.size === 'md' && 'px-[18px] py-2.5 text-sm',
  props.size === 'lg' && 'px-6 py-3.5 text-[15px]',
  props.kind === 'primary' && 'bg-brand-harmony text-white hover:bg-[#4a2161]',
  props.kind === 'secondary' &&
    'bg-white text-carbon border-calm hover:border-brand-harmony hover:text-brand-harmony',
  props.kind === 'ghost' &&
    'bg-transparent text-carbon-2 hover:bg-brand-harmony-sheer hover:text-brand-harmony',
  props.kind === 'cta' && 'bg-brand-hustle text-white hover:bg-[#b50848]',
])
</script>

<template>
  <NuxtLink v-if="to" :to="to" :class="buttonClass">
    <slot />
  </NuxtLink>
  <button v-else :type="type" :class="buttonClass">
    <slot />
  </button>
</template>
