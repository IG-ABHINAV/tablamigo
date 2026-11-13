import React from 'react';
import { Modal as RNModal, type ModalProps } from 'react-native';
import { useOverlay } from '../lib/overlay';

/** React Native's Modal, counted by lib/overlay.ts while it is open. Every modal in the app uses this one. */
export function Modal(props: ModalProps) {
  useOverlay(props.visible !== false);
  return <RNModal {...props} />;
}
