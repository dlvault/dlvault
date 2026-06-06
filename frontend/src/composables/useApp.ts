import { inject, type Ref } from 'vue';
import type ToastContainer from '../components/ToastContainer.vue';
import type ConfirmModal from '../components/ConfirmModal.vue';

type ToastRef = Ref<InstanceType<typeof ToastContainer> | undefined>;
type ConfirmRef = Ref<InstanceType<typeof ConfirmModal> | undefined>;

export function useToast(): ToastRef {
  const toast = inject<ToastRef>('toast');
  if (!toast) throw new Error('Toast not provided');
  return toast;
}

export function useConfirm(): ConfirmRef {
  const confirm = inject<ConfirmRef>('confirm');
  if (!confirm) throw new Error('ConfirmModal not provided');
  return confirm;
}
