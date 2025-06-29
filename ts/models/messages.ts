// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  isEmpty,
  isEqual,
  isNumber,
  isObject,
  mapValues,
  maxBy,
  noop,
  omit,
  partition,
  pick,
  union,
} from 'lodash';
import type {
  CustomError,
  MessageAttributesType,
  MessageReactionType,
  QuotedMessageType,
} from '../model-types.d';
import {
  filter,
  find,
  map,
  reduce,
  repeat,
  zipObject,
} from '../util/iterables';
import * as GoogleChrome from '../util/GoogleChrome';
import type { DeleteModel } from '../messageModifiers/Deletes';
import type { SentEventData } from '../textsecure/messageReceiverEvents';
import { isNotNil } from '../util/isNotNil';
import { isNormalNumber } from '../util/isNormalNumber';
import { softAssert, strictAssert } from '../util/assert';
import { missingCaseError } from '../util/missingCaseError';
import { drop } from '../util/drop';
import { dropNull } from '../util/dropNull';
import type { ConversationModel } from './conversations';
import { getCallingNotificationText } from '../util/callingNotification';
import type {
  ProcessedDataMessage,
  ProcessedQuote,
  ProcessedUnidentifiedDeliveryStatus,
  CallbackResultType,
} from '../textsecure/Types.d';
import { SendMessageProtoError } from '../textsecure/Errors';
import * as expirationTimer from '../util/expirationTimer';
import { getUserLanguages } from '../util/userLanguages';

import type { ReactionType } from '../types/Reactions';
import { UUID, UUIDKind } from '../types/UUID';
import * as reactionUtil from '../reactions/util';
import * as Stickers from '../types/Stickers';
import * as Errors from '../types/errors';
import * as EmbeddedContact from '../types/EmbeddedContact';
import type { AttachmentType } from '../types/Attachment';
import { isImage, isVideo } from '../types/Attachment';
import * as Attachment from '../types/Attachment';
import { stringToMIMEType } from '../types/MIME';
import * as MIME from '../types/MIME';
import * as GroupChange from '../groupChange';
import { ReadStatus } from '../messages/MessageReadStatus';
import type { SendStateByConversationId } from '../messages/MessageSendState';
import {
  SendActionType,
  SendStatus,
  isSent,
  sendStateReducer,
  someSendStatus,
} from '../messages/MessageSendState';
import { migrateLegacyReadStatus } from '../messages/migrateLegacyReadStatus';
import { migrateLegacySendAttributes } from '../messages/migrateLegacySendAttributes';
import { getOwn } from '../util/getOwn';
import { markRead, markViewed } from '../services/MessageUpdater';
import { scheduleOptimizeFTS } from '../services/ftsOptimizer';
import {
  isDirectConversation,
  isGroup,
  isGroupV1,
  isMe,
} from '../util/whatTypeOfConversation';
import { handleMessageSend } from '../util/handleMessageSend';
import { getSendOptions } from '../util/getSendOptions';
import { findAndFormatContact } from '../util/findAndFormatContact';
import { canConversationBeUnarchived } from '../util/canConversationBeUnarchived';
import {
  getAttachmentsForMessage,
  getMessagePropStatus,
  getPropsForCallHistory,
  hasErrors,
  isCallHistory,
  isChatSessionRefreshed,
  isContactRemovedNotification,
  isDeliveryIssue,
  isEndSession,
  isExpirationTimerUpdate,
  isGiftBadge,
  isGroupUpdate,
  isGroupV1Migration,
  isGroupV2Change,
  isIncoming,
  isKeyChange,
  isOutgoing,
  isStory,
  isProfileChange,
  isTapToView,
  isUniversalTimerNotification,
  isUnsupportedMessage,
  isVerifiedChange,
  isConversationMerge,
  extractHydratedMentions,
} from '../state/selectors/message';
import {
  isInCall,
  getCallSelector,
  getActiveCall,
} from '../state/selectors/calling';
import {
  MessageReceipts,
  MessageReceiptType,
} from '../messageModifiers/MessageReceipts';
import { Deletes } from '../messageModifiers/Deletes';
import type { ReactionModel } from '../messageModifiers/Reactions';
import { Reactions } from '../messageModifiers/Reactions';
import { ReactionSource } from '../reactions/ReactionSource';
import { ReadSyncs } from '../messageModifiers/ReadSyncs';
import { ViewSyncs } from '../messageModifiers/ViewSyncs';
import { ViewOnceOpenSyncs } from '../messageModifiers/ViewOnceOpenSyncs';
import * as LinkPreview from '../types/LinkPreview';
import { SignalService as Proto } from '../protobuf';
import {
  conversationJobQueue,
  conversationQueueJobEnum,
} from '../jobs/conversationJobQueue';
import { notificationService } from '../services/notifications';
import type {
  LinkPreviewType,
  LinkPreviewWithHydratedData,
} from '../types/message/LinkPreviews';
import * as log from '../logging/log';
import { cleanupMessage, deleteMessageData } from '../util/cleanup';
import {
  getContact,
  getSource,
  getSourceUuid,
  isCustomError,
  messageHasPaymentEvent,
  isQuoteAMatch,
  getPaymentEventNotificationText,
} from '../messages/helpers';
import type { ReplacementValuesType } from '../types/I18N';
import { viewOnceOpenJobQueue } from '../jobs/viewOnceOpenJobQueue';
import { getMessageIdForLogging } from '../util/idForLogging';
import { hasAttachmentDownloads } from '../util/hasAttachmentDownloads';
import { queueAttachmentDownloads } from '../util/queueAttachmentDownloads';
import { findStoryMessage } from '../util/findStoryMessage';
import { getStoryDataFromMessageAttributes } from '../services/storyLoader';
import type { ConversationQueueJobData } from '../jobs/conversationJobQueue';
import { getMessageById } from '../messages/getMessageById';
import { shouldDownloadStory } from '../util/shouldDownloadStory';
import { shouldShowStoriesView } from '../state/selectors/stories';
import type { EmbeddedContactWithHydratedAvatar } from '../types/EmbeddedContact';
import { SeenStatus } from '../MessageSeenStatus';
import { isNewReactionReplacingPrevious } from '../reactions/util';
import { parseBoostBadgeListFromServer } from '../badges/parseBadgesFromServer';
import { GiftBadgeStates } from '../components/conversation/Message';
import type { StickerWithHydratedData } from '../types/Stickers';
import { getStringForConversationMerge } from '../util/getStringForConversationMerge';
import {
  addToAttachmentDownloadQueue,
  shouldUseAttachmentDownloadQueue,
} from '../util/attachmentDownloadQueue';
import { getTitleNoDefault, getNumber } from '../util/getTitle';
import dataInterface from '../sql/Client';
import * as Edits from '../messageModifiers/Edits';
import { handleEditMessage } from '../util/handleEditMessage';
import { getQuoteBodyText } from '../util/getQuoteBodyText';
import { shouldReplyNotifyUser } from '../util/shouldReplyNotifyUser';
import { isConversationAccepted } from '../util/isConversationAccepted';
import type { RawBodyRange } from '../types/BodyRange';
import { BodyRange, applyRangesForText } from '../types/BodyRange';
import { deleteForEveryone } from '../util/deleteForEveryone';
import { getStringForProfileChange } from '../util/getStringForProfileChange';
import {
  queueUpdateMessage,
  saveNewMessageBatcher,
} from '../util/messageBatcher';

/* eslint-disable more/no-then */

window.Whisper = window.Whisper || {};

const { Message: TypedMessage } = window.Signal.Types;
const { upgradeMessageSchema } = window.Signal.Migrations;
const { getMessageBySender } = window.Signal.Data;

export class MessageModel extends window.Backbone.Model<MessageAttributesType> {
  CURRENT_PROTOCOL_VERSION?: number;

  // Set when sending some sync messages, so we get the functionality of
  //   send(), without zombie messages going into the database.
  doNotSave?: boolean;
  // Set when sending stories, so we get the functionality of send() but we are
  //   able to send the sync message elsewhere.
  doNotSendSyncMessage?: boolean;

  INITIAL_PROTOCOL_VERSION?: number;

  deletingForEveryone?: boolean;

  isSelected?: boolean;

  private pendingMarkRead?: number;

  syncPromise?: Promise<CallbackResultType | void>;

  cachedOutgoingContactData?: Array<EmbeddedContactWithHydratedAvatar>;

  cachedOutgoingPreviewData?: Array<LinkPreviewWithHydratedData>;

  cachedOutgoingQuoteData?: QuotedMessageType;

  cachedOutgoingStickerData?: StickerWithHydratedData;

  constructor(attributes: MessageAttributesType) {
    super(attributes);

    // Note that we intentionally don't use `initialize()` method because it
    // isn't compatible with esnext output of esbuild.
    if (isObject(attributes)) {
      this.set(
        TypedMessage.initializeSchemaVersion({
          message: attributes as MessageAttributesType,
          logger: log,
        })
      );
    }

    const readStatus = migrateLegacyReadStatus(this.attributes);
    if (readStatus !== undefined) {
      this.set(
        {
          readStatus,
          seenStatus:
            readStatus === ReadStatus.Unread
              ? SeenStatus.Unseen
              : SeenStatus.Seen,
        },
        { silent: true }
      );
    }

    const ourConversationId =
      window.ConversationController.getOurConversationId();
    if (ourConversationId) {
      const sendStateByConversationId = migrateLegacySendAttributes(
        this.attributes,
        window.ConversationController.get.bind(window.ConversationController),
        ourConversationId
      );
      if (sendStateByConversationId) {
        this.set('sendStateByConversationId', sendStateByConversationId, {
          silent: true,
        });
      }
    }

    this.CURRENT_PROTOCOL_VERSION = Proto.DataMessage.ProtocolVersion.CURRENT;
    this.INITIAL_PROTOCOL_VERSION = Proto.DataMessage.ProtocolVersion.INITIAL;

    this.on('change', this.notifyRedux);
  }

  notifyRedux(): void {
    if (!window.reduxActions) {
      return;
    }

    const { storyChanged } = window.reduxActions.stories;

    if (isStory(this.attributes)) {
      const storyData = getStoryDataFromMessageAttributes({
        ...this.attributes,
      });

      if (!storyData) {
        return;
      }

      storyChanged(storyData);

      // We don't want messageChanged to run
      return;
    }

    const { messageChanged } = window.reduxActions.conversations;

    if (messageChanged) {
      const conversationId = this.get('conversationId');
      // Note: The clone is important for triggering a re-run of selectors
      messageChanged(this.id, conversationId, { ...this.attributes });
    }
  }

  getSenderIdentifier(): string {
    const sentAt = this.get('sent_at');
    const source = this.get('source');
    const sourceUuid = this.get('sourceUuid');
    const sourceDevice = this.get('sourceDevice');

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conversation = window.ConversationController.lookupOrCreate({
      e164: source,
      uuid: sourceUuid,
      reason: 'MessageModel.getSenderIdentifier',
    })!;

    return `${conversation?.id}.${sourceDevice}-${sentAt}`;
  }

  getReceivedAt(): number {
    // We would like to get the received_at_ms ideally since received_at is
    // now an incrementing counter for messages and not the actual time that
    // the message was received. If this field doesn't exist on the message
    // then we can trust received_at.
    return Number(this.get('received_at_ms') || this.get('received_at'));
  }

  isNormalBubble(): boolean {
    const { attributes } = this;

    return (
      !isCallHistory(attributes) &&
      !isChatSessionRefreshed(attributes) &&
      !isContactRemovedNotification(attributes) &&
      !isConversationMerge(attributes) &&
      !isEndSession(attributes) &&
      !isExpirationTimerUpdate(attributes) &&
      !isGroupUpdate(attributes) &&
      !isGroupV1Migration(attributes) &&
      !isGroupV2Change(attributes) &&
      !isKeyChange(attributes) &&
      !isProfileChange(attributes) &&
      !isUniversalTimerNotification(attributes) &&
      !isUnsupportedMessage(attributes) &&
      !isVerifiedChange(attributes)
    );
  }

  async hydrateStoryContext(
    inMemoryMessage?: MessageAttributesType
  ): Promise<void> {
    const storyId = this.get('storyId');
    if (!storyId) {
      return;
    }

    const context = this.get('storyReplyContext');
    // We'll continue trying to get the attachment as long as the message still exists
    if (context && (context.attachment?.url || !context.messageId)) {
      return;
    }

    const message =
      inMemoryMessage === undefined
        ? (await getMessageById(storyId))?.attributes
        : inMemoryMessage;

    if (!message) {
      const conversation = this.getConversation();
      softAssert(
        conversation && isDirectConversation(conversation.attributes),
        'hydrateStoryContext: Not a type=direct conversation'
      );
      this.set({
        storyReplyContext: {
          attachment: undefined,
          // This is ok to do because story replies only show in 1:1 conversations
          // so the story that was quoted should be from the same conversation.
          authorUuid: conversation?.get('uuid'),
          // No messageId, referenced story not found!
          messageId: '',
        },
      });
      return;
    }

    const attachments = getAttachmentsForMessage({ ...message });
    let attachment: AttachmentType | undefined = attachments?.[0];
    if (attachment && !attachment.url && !attachment.textAttachment) {
      attachment = undefined;
    }

    this.set({
      storyReplyContext: {
        attachment,
        authorUuid: message.sourceUuid,
        messageId: message.id,
      },
    });
  }

  // Dependencies of prop-generation functions
  getConversation(): ConversationModel | undefined {
    return window.ConversationController.get(this.get('conversationId'));
  }

  getNotificationData(): {
    emoji?: string;
    text: string;
    bodyRanges?: ReadonlyArray<RawBodyRange>;
  } {
    // eslint-disable-next-line prefer-destructuring
    const attributes: MessageAttributesType = this.attributes;

    if (isDeliveryIssue(attributes)) {
      return {
        emoji: '⚠️',
        text: window.i18n('icu:DeliveryIssue--preview'),
      };
    }

    if (isConversationMerge(attributes)) {
      const conversation = this.getConversation();
      strictAssert(
        conversation,
        'getNotificationData/isConversationMerge/conversation'
      );
      strictAssert(
        attributes.conversationMerge,
        'getNotificationData/isConversationMerge/conversationMerge'
      );

      return {
        text: getStringForConversationMerge({
          obsoleteConversationTitle: getTitleNoDefault(
            attributes.conversationMerge.renderInfo
          ),
          obsoleteConversationNumber: getNumber(
            attributes.conversationMerge.renderInfo
          ),
          conversationTitle: conversation.getTitle(),
          i18n: window.i18n,
        }),
      };
    }

    if (isChatSessionRefreshed(attributes)) {
      return {
        emoji: '🔁',
        text: window.i18n('icu:ChatRefresh--notification'),
      };
    }

    if (isUnsupportedMessage(attributes)) {
      return {
        text: window.i18n('icu:message--getDescription--unsupported-message'),
      };
    }

    if (isGroupV1Migration(attributes)) {
      return {
        text: window.i18n('icu:GroupV1--Migration--was-upgraded'),
      };
    }

    if (isProfileChange(attributes)) {
      const change = this.get('profileChange');
      const changedId = this.get('changedId');
      const changedContact = findAndFormatContact(changedId);
      if (!change) {
        throw new Error('getNotificationData: profileChange was missing!');
      }

      return {
        text: getStringForProfileChange(change, changedContact, window.i18n),
      };
    }

    if (isGroupV2Change(attributes)) {
      const change = this.get('groupV2Change');
      strictAssert(
        change,
        'getNotificationData: isGroupV2Change true, but no groupV2Change!'
      );

      const changes = GroupChange.renderChange<string>(change, {
        i18n: window.i18n,
        ourACI: window.textsecure.storage.user
          .getCheckedUuid(UUIDKind.ACI)
          .toString(),
        ourPNI: window.textsecure.storage.user
          .getCheckedUuid(UUIDKind.PNI)
          .toString(),
        renderContact: (conversationId: string) => {
          const conversation =
            window.ConversationController.get(conversationId);
          return conversation
            ? conversation.getTitle()
            : window.i18n('icu:unknownContact');
        },
        renderString: (
          key: string,
          _i18n: unknown,
          components: ReplacementValuesType<string | number> | undefined
        ) => {
          // eslint-disable-next-line local-rules/valid-i18n-keys
          return window.i18n(key, components);
        },
      });

      return { text: changes.map(({ text }) => text).join(' ') };
    }

    if (messageHasPaymentEvent(attributes)) {
      const sender = findAndFormatContact(attributes.sourceUuid);
      const conversation = findAndFormatContact(attributes.conversationId);
      return {
        text: getPaymentEventNotificationText(
          attributes.payment,
          sender.title,
          conversation.title,
          sender.isMe,
          window.i18n
        ),
        emoji: '💳',
      };
    }

    const attachments = this.get('attachments') || [];

    if (isTapToView(attributes)) {
      if (this.isErased()) {
        return {
          text: window.i18n('icu:message--getDescription--disappearing-media'),
        };
      }

      if (Attachment.isImage(attachments)) {
        return {
          text: window.i18n('icu:message--getDescription--disappearing-photo'),
          emoji: '📷',
        };
      }
      if (Attachment.isVideo(attachments)) {
        return {
          text: window.i18n('icu:message--getDescription--disappearing-video'),
          emoji: '🎥',
        };
      }
      // There should be an image or video attachment, but we have a fallback just in
      //   case.
      return { text: window.i18n('icu:mediaMessage'), emoji: '📎' };
    }

    if (isGroupUpdate(attributes)) {
      const groupUpdate = this.get('group_update');
      const fromContact = getContact(this.attributes);
      const messages = [];
      if (!groupUpdate) {
        throw new Error('getNotificationData: Missing group_update');
      }

      if (groupUpdate.left === 'You') {
        return { text: window.i18n('icu:youLeftTheGroup') };
      }
      if (groupUpdate.left) {
        return {
          text: window.i18n('icu:leftTheGroup', {
            name: this.getNameForNumber(groupUpdate.left),
          }),
        };
      }

      if (!fromContact) {
        return { text: '' };
      }

      if (isMe(fromContact.attributes)) {
        messages.push(window.i18n('icu:youUpdatedTheGroup'));
      } else {
        messages.push(
          window.i18n('icu:updatedTheGroup', {
            name: fromContact.getTitle(),
          })
        );
      }

      if (groupUpdate.joined && groupUpdate.joined.length) {
        const joinedContacts = groupUpdate.joined.map(item =>
          window.ConversationController.getOrCreate(item, 'private')
        );
        const joinedWithoutMe = joinedContacts.filter(
          contact => !isMe(contact.attributes)
        );

        if (joinedContacts.length > 1) {
          messages.push(
            window.i18n('icu:multipleJoinedTheGroup', {
              names: joinedWithoutMe
                .map(contact => contact.getTitle())
                .join(', '),
            })
          );

          if (joinedWithoutMe.length < joinedContacts.length) {
            messages.push(window.i18n('icu:youJoinedTheGroup'));
          }
        } else {
          const joinedContact = window.ConversationController.getOrCreate(
            groupUpdate.joined[0],
            'private'
          );
          if (isMe(joinedContact.attributes)) {
            messages.push(window.i18n('icu:youJoinedTheGroup'));
          } else {
            messages.push(
              window.i18n('icu:joinedTheGroup', {
                name: joinedContacts[0].getTitle(),
              })
            );
          }
        }
      }

      if (groupUpdate.name) {
        messages.push(
          window.i18n('icu:titleIsNow', {
            name: groupUpdate.name,
          })
        );
      }
      if (groupUpdate.avatarUpdated) {
        messages.push(window.i18n('icu:updatedGroupAvatar'));
      }

      return { text: messages.join(' ') };
    }
    if (isEndSession(attributes)) {
      return { text: window.i18n('icu:sessionEnded') };
    }
    if (isIncoming(attributes) && hasErrors(attributes)) {
      return { text: window.i18n('icu:incomingError') };
    }

    const body = (this.get('body') || '').trim();
    const bodyRanges = this.get('bodyRanges') || [];

    if (attachments.length) {
      // This should never happen but we want to be extra-careful.
      const attachment = attachments[0] || {};
      const { contentType } = attachment;

      if (contentType === MIME.IMAGE_GIF || Attachment.isGIF(attachments)) {
        return {
          bodyRanges,
          emoji: '🎡',
          text: body || window.i18n('icu:message--getNotificationText--gif'),
        };
      }
      if (Attachment.isImage(attachments)) {
        return {
          bodyRanges,
          emoji: '📷',
          text: body || window.i18n('icu:message--getNotificationText--photo'),
        };
      }
      if (Attachment.isVideo(attachments)) {
        return {
          bodyRanges,
          emoji: '🎥',
          text: body || window.i18n('icu:message--getNotificationText--video'),
        };
      }
      if (Attachment.isVoiceMessage(attachment)) {
        return {
          bodyRanges,
          emoji: '🎤',
          text:
            body ||
            window.i18n('icu:message--getNotificationText--voice-message'),
        };
      }
      if (Attachment.isAudio(attachments)) {
        return {
          bodyRanges,
          emoji: '🔈',
          text:
            body ||
            window.i18n('icu:message--getNotificationText--audio-message'),
        };
      }

      return {
        bodyRanges,
        text: body || window.i18n('icu:message--getNotificationText--file'),
        emoji: '📎',
      };
    }

    const stickerData = this.get('sticker');
    if (stickerData) {
      const emoji =
        Stickers.getSticker(stickerData.packId, stickerData.stickerId)?.emoji ||
        stickerData?.emoji;

      if (!emoji) {
        log.warn('Unable to get emoji for sticker');
      }
      return {
        text: window.i18n('icu:message--getNotificationText--stickers'),
        emoji: dropNull(emoji),
      };
    }

    if (isCallHistory(attributes)) {
      const state = window.reduxStore.getState();
      const callingNotification = getPropsForCallHistory(attributes, {
        conversationSelector: findAndFormatContact,
        callSelector: getCallSelector(state),
        activeCall: getActiveCall(state),
      });
      if (callingNotification) {
        return {
          text: getCallingNotificationText(callingNotification, window.i18n),
        };
      }

      log.error("This call history message doesn't have valid call history");
    }
    if (isExpirationTimerUpdate(attributes)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { expireTimer } = this.get('expirationTimerUpdate')!;
      if (!expireTimer) {
        return { text: window.i18n('icu:disappearingMessagesDisabled') };
      }

      return {
        text: window.i18n('icu:timerSetTo', {
          time: expirationTimer.format(window.i18n, expireTimer),
        }),
      };
    }

    if (isKeyChange(attributes)) {
      const identifier = this.get('key_changed');
      const conversation = window.ConversationController.get(identifier);
      return {
        text: window.i18n('icu:safetyNumberChangedGroup', {
          name: conversation ? conversation.getTitle() : '',
        }),
      };
    }
    const contacts = this.get('contact');
    if (contacts && contacts.length) {
      return {
        text:
          EmbeddedContact.getName(contacts[0]) ||
          window.i18n('icu:unknownContact'),
        emoji: '👤',
      };
    }

    const giftBadge = this.get('giftBadge');
    if (giftBadge) {
      const emoji = '✨';
      const fromContact = getContact(this.attributes);

      if (isOutgoing(this.attributes)) {
        const recipient =
          fromContact?.getTitle() ?? window.i18n('icu:unknownContact');
        return {
          emoji,
          text: window.i18n('icu:message--donation--preview--sent', {
            recipient,
          }),
        };
      }

      const sender =
        fromContact?.getTitle() ?? window.i18n('icu:unknownContact');
      return {
        emoji,
        text:
          giftBadge.state === GiftBadgeStates.Unopened
            ? window.i18n('icu:message--donation--preview--unopened', {
                sender,
              })
            : window.i18n('icu:message--donation--preview--redeemed'),
      };
    }

    if (body) {
      return {
        text: body,
        bodyRanges,
      };
    }

    return { text: '' };
  }

  getAuthorText(): string | undefined {
    // if it's outgoing, it must be self-authored
    const selfAuthor = isOutgoing(this.attributes)
      ? window.i18n('icu:you')
      : undefined;

    // if it's not selfAuthor and there's no incoming contact,
    // it might be a group notification, so we return undefined
    return selfAuthor ?? this.getIncomingContact()?.getTitle({ isShort: true });
  }

  getNotificationText(): string {
    const { text, emoji } = this.getNotificationData();
    const { attributes } = this;

    const conversation = this.getConversation();

    strictAssert(
      conversation != null,
      'Conversation not found in ConversationController'
    );

    if (!isConversationAccepted(conversation.attributes)) {
      return window.i18n('icu:message--getNotificationText--messageRequest');
    }

    if (attributes.storyReaction) {
      if (attributes.type === 'outgoing') {
        const name = this.getConversation()?.get('profileName');

        if (!name) {
          return window.i18n(
            'icu:Quote__story-reaction-notification--outgoing--nameless',
            {
              emoji: attributes.storyReaction.emoji,
            }
          );
        }

        return window.i18n('icu:Quote__story-reaction-notification--outgoing', {
          emoji: attributes.storyReaction.emoji,
          name,
        });
      }

      const ourUuid = window.textsecure.storage.user
        .getCheckedUuid()
        .toString();

      if (
        attributes.type === 'incoming' &&
        attributes.storyReaction.targetAuthorUuid === ourUuid
      ) {
        return window.i18n('icu:Quote__story-reaction-notification--incoming', {
          emoji: attributes.storyReaction.emoji,
        });
      }

      if (!window.Signal.OS.isLinux()) {
        return attributes.storyReaction.emoji;
      }

      return window.i18n('icu:Quote__story-reaction--single');
    }

    const mentions =
      extractHydratedMentions(attributes, {
        conversationSelector: findAndFormatContact,
      }) || [];
    const spoilers = (attributes.bodyRanges || []).filter(
      range =>
        BodyRange.isFormatting(range) && range.style === BodyRange.Style.SPOILER
    ) as Array<BodyRange<BodyRange.Formatting>>;
    const modifiedText = applyRangesForText({ text, mentions, spoilers });

    // Linux emoji support is mixed, so we disable it. (Note that this doesn't touch
    //   the `text`, which can contain emoji.)
    const shouldIncludeEmoji = Boolean(emoji) && !window.Signal.OS.isLinux();
    if (shouldIncludeEmoji) {
      return window.i18n('icu:message--getNotificationText--text-with-emoji', {
        text: modifiedText,
        emoji,
      });
    }

    return modifiedText || '';
  }

  // General
  idForLogging(): string {
    return getMessageIdForLogging(this.attributes);
  }

  override defaults(): Partial<MessageAttributesType> {
    return {
      timestamp: new Date().getTime(),
      attachments: [],
    };
  }

  override validate(attributes: Record<string, unknown>): void {
    const required = ['conversationId', 'received_at', 'sent_at'];
    const missing = required.filter(attr => !attributes[attr]);
    if (missing.length) {
      log.warn(`Message missing attributes: ${missing}`);
    }
  }

  merge(model: MessageModel): void {
    const attributes = model.attributes || model;
    this.set(attributes);
  }

  getNameForNumber(number: string): string {
    const conversation = window.ConversationController.get(number);
    if (!conversation) {
      return number;
    }
    return conversation.getTitle();
  }

  async cleanup(): Promise<void> {
    await cleanupMessage(this.attributes);
  }

  async deleteData(): Promise<void> {
    await deleteMessageData(this.attributes);
  }

  isValidTapToView(): boolean {
    const body = this.get('body');
    if (body) {
      return false;
    }

    const attachments = this.get('attachments');
    if (!attachments || attachments.length !== 1) {
      return false;
    }

    const firstAttachment = attachments[0];
    if (
      !GoogleChrome.isImageTypeSupported(firstAttachment.contentType) &&
      !GoogleChrome.isVideoTypeSupported(firstAttachment.contentType)
    ) {
      return false;
    }

    const quote = this.get('quote');
    const sticker = this.get('sticker');
    const contact = this.get('contact');
    const preview = this.get('preview');

    if (
      quote ||
      sticker ||
      (contact && contact.length > 0) ||
      (preview && preview.length > 0)
    ) {
      return false;
    }

    return true;
  }

  async markViewOnceMessageViewed(options?: {
    fromSync?: boolean;
  }): Promise<void> {
    const { fromSync } = options || {};

    if (!this.isValidTapToView()) {
      log.warn(
        `markViewOnceMessageViewed: Message ${this.idForLogging()} is not a valid tap to view message!`
      );
      return;
    }
    if (this.isErased()) {
      log.warn(
        `markViewOnceMessageViewed: Message ${this.idForLogging()} is already erased!`
      );
      return;
    }

    if (this.get('readStatus') !== ReadStatus.Viewed) {
      this.set(markViewed(this.attributes));
    }

    await this.eraseContents();

    if (!fromSync) {
      const senderE164 = getSource(this.attributes);
      const senderUuid = getSourceUuid(this.attributes);
      const timestamp = this.get('sent_at');

      if (senderUuid === undefined) {
        throw new Error('markViewOnceMessageViewed: senderUuid is undefined');
      }

      if (window.ConversationController.areWePrimaryDevice()) {
        log.warn(
          'markViewOnceMessageViewed: We are primary device; not sending view once open sync'
        );
        return;
      }

      try {
        await viewOnceOpenJobQueue.add({
          viewOnceOpens: [
            {
              senderE164,
              senderUuid,
              timestamp,
            },
          ],
        });
      } catch (error) {
        log.error(
          'markViewOnceMessageViewed: Failed to queue view once open sync',
          Errors.toLogFormat(error)
        );
      }
    }
  }

  async doubleCheckMissingQuoteReference(): Promise<void> {
    const logId = this.idForLogging();

    const storyId = this.get('storyId');
    if (storyId) {
      log.warn(
        `doubleCheckMissingQuoteReference/${logId}: missing story reference`
      );

      const message = window.MessageController.getById(storyId);
      if (!message) {
        return;
      }

      if (this.get('storyReplyContext')) {
        this.unset('storyReplyContext');
      }
      await this.hydrateStoryContext(message.attributes);
      return;
    }

    const quote = this.get('quote');
    if (!quote) {
      log.warn(`doubleCheckMissingQuoteReference/${logId}: Missing quote!`);
      return;
    }

    const { authorUuid, author, id: sentAt, referencedMessageNotFound } = quote;
    const contact = window.ConversationController.get(authorUuid || author);

    // Is the quote really without a reference? Check with our in memory store
    // first to make sure it's not there.
    if (referencedMessageNotFound && contact) {
      log.info(
        `doubleCheckMissingQuoteReference/${logId}: Verifying reference to ${sentAt}`
      );
      const inMemoryMessages = window.MessageController.filterBySentAt(
        Number(sentAt)
      );
      let matchingMessage = find(inMemoryMessages, message =>
        isQuoteAMatch(message.attributes, this.get('conversationId'), quote)
      );
      if (!matchingMessage) {
        const messages = await window.Signal.Data.getMessagesBySentAt(
          Number(sentAt)
        );
        const found = messages.find(item =>
          isQuoteAMatch(item, this.get('conversationId'), quote)
        );
        if (found) {
          matchingMessage = window.MessageController.register(found.id, found);
        }
      }

      if (!matchingMessage) {
        log.info(
          `doubleCheckMissingQuoteReference/${logId}: No match for ${sentAt}.`
        );
        return;
      }

      this.set({
        quote: {
          ...quote,
          referencedMessageNotFound: false,
        },
      });

      log.info(
        `doubleCheckMissingQuoteReference/${logId}: Found match for ${sentAt}, updating.`
      );

      await this.copyQuoteContentFromOriginal(matchingMessage, quote);
      this.set({
        quote: {
          ...quote,
          referencedMessageNotFound: false,
        },
      });
      queueUpdateMessage(this.attributes);
    }
  }

  isErased(): boolean {
    return Boolean(this.get('isErased'));
  }

  async eraseContents(
    additionalProperties = {},
    shouldPersist = true
  ): Promise<void> {
    log.info(`Erasing data for message ${this.idForLogging()}`);

    // Note: There are cases where we want to re-erase a given message. For example, when
    //   a viewed (or outgoing) View-Once message is deleted for everyone.

    try {
      await this.deleteData();
    } catch (error) {
      log.error(
        `Error erasing data for message ${this.idForLogging()}:`,
        Errors.toLogFormat(error)
      );
    }

    this.set({
      attachments: [],
      body: '',
      bodyRanges: undefined,
      contact: [],
      editHistory: undefined,
      isErased: true,
      preview: [],
      quote: undefined,
      sticker: undefined,
      ...additionalProperties,
    });
    this.getConversation()?.debouncedUpdateLastMessage?.();

    if (shouldPersist) {
      await window.Signal.Data.saveMessage(this.attributes, {
        ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
      });
    }

    await window.Signal.Data.deleteSentProtoByMessageId(this.id);

    scheduleOptimizeFTS();
  }

  override isEmpty(): boolean {
    const { attributes } = this;

    // Core message types - we check for all four because they can each stand alone
    const hasBody = Boolean(this.get('body'));
    const hasAttachment = (this.get('attachments') || []).length > 0;
    const hasEmbeddedContact = (this.get('contact') || []).length > 0;
    const isSticker = Boolean(this.get('sticker'));

    // Rendered sync messages
    const isCallHistoryValue = isCallHistory(attributes);
    const isChatSessionRefreshedValue = isChatSessionRefreshed(attributes);
    const isDeliveryIssueValue = isDeliveryIssue(attributes);
    const isGiftBadgeValue = isGiftBadge(attributes);
    const isGroupUpdateValue = isGroupUpdate(attributes);
    const isGroupV2ChangeValue = isGroupV2Change(attributes);
    const isEndSessionValue = isEndSession(attributes);
    const isExpirationTimerUpdateValue = isExpirationTimerUpdate(attributes);
    const isVerifiedChangeValue = isVerifiedChange(attributes);

    // Placeholder messages
    const isUnsupportedMessageValue = isUnsupportedMessage(attributes);
    const isTapToViewValue = isTapToView(attributes);

    // Errors
    const hasErrorsValue = hasErrors(attributes);

    // Locally-generated notifications
    const isKeyChangeValue = isKeyChange(attributes);
    const isProfileChangeValue = isProfileChange(attributes);
    const isUniversalTimerNotificationValue =
      isUniversalTimerNotification(attributes);
    const isConversationMergeValue = isConversationMerge(attributes);

    const isPayment = messageHasPaymentEvent(attributes);

    // Note: not all of these message types go through message.handleDataMessage

    const hasSomethingToDisplay =
      // Core message types
      hasBody ||
      hasAttachment ||
      hasEmbeddedContact ||
      isSticker ||
      isPayment ||
      // Rendered sync messages
      isCallHistoryValue ||
      isChatSessionRefreshedValue ||
      isDeliveryIssueValue ||
      isGiftBadgeValue ||
      isGroupUpdateValue ||
      isGroupV2ChangeValue ||
      isEndSessionValue ||
      isExpirationTimerUpdateValue ||
      isVerifiedChangeValue ||
      // Placeholder messages
      isUnsupportedMessageValue ||
      isTapToViewValue ||
      // Errors
      hasErrorsValue ||
      // Locally-generated notifications
      isKeyChangeValue ||
      isProfileChangeValue ||
      isUniversalTimerNotificationValue ||
      isConversationMergeValue;

    return !hasSomethingToDisplay;
  }

  isUnidentifiedDelivery(
    contactId: string,
    unidentifiedDeliveriesSet: Readonly<Set<string>>
  ): boolean {
    if (isIncoming(this.attributes)) {
      return Boolean(this.get('unidentifiedDeliveryReceived'));
    }

    return unidentifiedDeliveriesSet.has(contactId);
  }

  async saveErrors(
    providedErrors: Error | Array<Error>,
    options: { skipSave?: boolean } = {}
  ): Promise<void> {
    const { skipSave } = options;

    let errors: Array<CustomError>;

    if (!(providedErrors instanceof Array)) {
      errors = [providedErrors];
    } else {
      errors = providedErrors;
    }

    errors.forEach(e => {
      log.error('Message.saveErrors:', Errors.toLogFormat(e));
    });
    errors = errors.map(e => {
      // Note: in our environment, instanceof can be scary, so we have a backup check
      //   (Node.js vs Browser context).
      // We check instanceof second because typescript believes that anything that comes
      //   through here must be an instance of Error, so e is 'never' after that check.
      if ((e.message && e.stack) || e instanceof Error) {
        return pick(
          e,
          'name',
          'message',
          'code',
          'number',
          'identifier',
          'retryAfter',
          'data',
          'reason'
        ) as Required<Error>;
      }
      return e;
    });
    errors = errors.concat(this.get('errors') || []);

    this.set({ errors });

    if (!skipSave && !this.doNotSave) {
      await window.Signal.Data.saveMessage(this.attributes, {
        ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
      });
    }
  }

  markRead(readAt?: number, options = {}): void {
    this.set(markRead(this.attributes, readAt, options));
  }

  getIncomingContact(): ConversationModel | undefined | null {
    if (!isIncoming(this.attributes)) {
      return null;
    }
    const sourceUuid = this.get('sourceUuid');
    if (!sourceUuid) {
      return null;
    }

    return window.ConversationController.getOrCreate(sourceUuid, 'private');
  }

  async retrySend(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conversation = this.getConversation()!;

    let currentConversationRecipients: Set<string> | undefined;

    const { storyDistributionListId } = this.attributes;

    if (storyDistributionListId) {
      const storyDistribution =
        await dataInterface.getStoryDistributionWithMembers(
          storyDistributionListId
        );

      if (!storyDistribution) {
        this.markFailed();
        return;
      }

      currentConversationRecipients = new Set(
        storyDistribution.members
          .map(uuid => window.ConversationController.get(uuid)?.id)
          .filter(isNotNil)
      );
    } else {
      currentConversationRecipients = conversation.getMemberConversationIds();
    }

    // Determine retry recipients and get their most up-to-date addressing information
    const oldSendStateByConversationId =
      this.get('sendStateByConversationId') || {};

    const newSendStateByConversationId = { ...oldSendStateByConversationId };
    for (const [conversationId, sendState] of Object.entries(
      oldSendStateByConversationId
    )) {
      if (isSent(sendState.status)) {
        continue;
      }

      const recipient = window.ConversationController.get(conversationId);
      if (
        !recipient ||
        (!currentConversationRecipients.has(conversationId) &&
          !isMe(recipient.attributes))
      ) {
        continue;
      }

      newSendStateByConversationId[conversationId] = sendStateReducer(
        sendState,
        {
          type: SendActionType.ManuallyRetried,
          updatedAt: Date.now(),
        }
      );
    }

    this.set('sendStateByConversationId', newSendStateByConversationId);

    if (isStory(this.attributes)) {
      await conversationJobQueue.add(
        {
          type: conversationQueueJobEnum.enum.Story,
          conversationId: conversation.id,
          messageIds: [this.id],
          // using the group timestamp, which will differ from the 1:1 timestamp
          timestamp: this.attributes.timestamp,
        },
        async jobToInsert => {
          await window.Signal.Data.saveMessage(this.attributes, {
            jobToInsert,
            ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
          });
        }
      );
    } else {
      await conversationJobQueue.add(
        {
          type: conversationQueueJobEnum.enum.NormalMessage,
          conversationId: conversation.id,
          messageId: this.id,
          revision: conversation.get('revision'),
        },
        async jobToInsert => {
          await window.Signal.Data.saveMessage(this.attributes, {
            jobToInsert,
            ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
          });
        }
      );
    }
  }

  isReplayableError(e: Error): boolean {
    return (
      e.name === 'MessageError' ||
      e.name === 'OutgoingMessageError' ||
      e.name === 'SendMessageNetworkError' ||
      e.name === 'SendMessageChallengeError' ||
      e.name === 'SignedPreKeyRotationError' ||
      e.name === 'OutgoingIdentityKeyError'
    );
  }

  public hasSuccessfulDelivery(): boolean {
    const sendStateByConversationId = this.get('sendStateByConversationId');
    const withoutMe = omit(
      sendStateByConversationId,
      window.ConversationController.getOurConversationIdOrThrow()
    );
    return isEmpty(withoutMe) || someSendStatus(withoutMe, isSent);
  }

  /**
   * Change any Pending send state to Failed. Note that this will not mark successful
   * sends failed.
   */
  public markFailed(): void {
    const now = Date.now();
    this.set(
      'sendStateByConversationId',
      mapValues(this.get('sendStateByConversationId') || {}, sendState =>
        sendStateReducer(sendState, {
          type: SendActionType.Failed,
          updatedAt: now,
        })
      )
    );

    this.notifyStorySendFailed();
  }

  public notifyStorySendFailed(): void {
    if (!isStory(this.attributes)) {
      return;
    }

    notificationService.add({
      conversationId: this.get('conversationId'),
      storyId: this.id,
      messageId: this.id,
      senderTitle:
        this.getConversation()?.getTitle() ?? window.i18n('icu:Stories__mine'),
      message: this.hasSuccessfulDelivery()
        ? window.i18n('icu:Stories__failed-send--partial')
        : window.i18n('icu:Stories__failed-send--full'),
      isExpiringMessage: false,
    });
  }

  removeOutgoingErrors(incomingIdentifier: string): CustomError {
    const incomingConversationId =
      window.ConversationController.getConversationId(incomingIdentifier);
    const errors = partition(
      this.get('errors'),
      e =>
        window.ConversationController.getConversationId(
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          e.identifier || e.number!
        ) === incomingConversationId &&
        (e.name === 'MessageError' ||
          e.name === 'OutgoingMessageError' ||
          e.name === 'SendMessageNetworkError' ||
          e.name === 'SendMessageChallengeError' ||
          e.name === 'SignedPreKeyRotationError' ||
          e.name === 'OutgoingIdentityKeyError')
    );
    this.set({ errors: errors[1] });
    return errors[0][0];
  }

  async send(
    promise: Promise<CallbackResultType | void | null>,
    saveErrors?: (errors: Array<Error>) => void
  ): Promise<void> {
    const updateLeftPane =
      this.getConversation()?.debouncedUpdateLastMessage || noop;

    updateLeftPane();

    let result:
      | { success: true; value: CallbackResultType }
      | {
          success: false;
          value: CustomError | SendMessageProtoError;
        };
    try {
      const value = await (promise as Promise<CallbackResultType>);
      result = { success: true, value };
    } catch (err) {
      result = { success: false, value: err };
    }

    updateLeftPane();

    const attributesToUpdate: Partial<MessageAttributesType> = {};

    // This is used by sendSyncMessage, then set to null
    if ('dataMessage' in result.value && result.value.dataMessage) {
      attributesToUpdate.dataMessage = result.value.dataMessage;
    } else if ('editMessage' in result.value && result.value.editMessage) {
      attributesToUpdate.dataMessage = result.value.editMessage;
    }

    if (!this.doNotSave) {
      await window.Signal.Data.saveMessage(this.attributes, {
        ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
      });
    }

    const sendStateByConversationId = {
      ...(this.get('sendStateByConversationId') || {}),
    };

    const sendIsNotFinal =
      'sendIsNotFinal' in result.value && result.value.sendIsNotFinal;
    const sendIsFinal = !sendIsNotFinal;

    // Capture successful sends
    const successfulIdentifiers: Array<string> =
      sendIsFinal &&
      'successfulIdentifiers' in result.value &&
      Array.isArray(result.value.successfulIdentifiers)
        ? result.value.successfulIdentifiers
        : [];
    const sentToAtLeastOneRecipient =
      result.success || Boolean(successfulIdentifiers.length);

    successfulIdentifiers.forEach(identifier => {
      const conversation = window.ConversationController.get(identifier);
      if (!conversation) {
        return;
      }

      // If we successfully sent to a user, we can remove our unregistered flag.
      if (conversation.isEverUnregistered()) {
        conversation.setRegistered();
      }

      const previousSendState = getOwn(
        sendStateByConversationId,
        conversation.id
      );
      if (previousSendState) {
        sendStateByConversationId[conversation.id] = sendStateReducer(
          previousSendState,
          {
            type: SendActionType.Sent,
            updatedAt: Date.now(),
          }
        );
      }
    });

    // Integrate sends via sealed sender
    const previousUnidentifiedDeliveries =
      this.get('unidentifiedDeliveries') || [];
    const newUnidentifiedDeliveries =
      sendIsFinal &&
      'unidentifiedDeliveries' in result.value &&
      Array.isArray(result.value.unidentifiedDeliveries)
        ? result.value.unidentifiedDeliveries
        : [];

    const promises: Array<Promise<unknown>> = [];

    // Process errors
    let errors: Array<CustomError>;
    if (result.value instanceof SendMessageProtoError && result.value.errors) {
      ({ errors } = result.value);
    } else if (isCustomError(result.value)) {
      errors = [result.value];
    } else if (Array.isArray(result.value.errors)) {
      ({ errors } = result.value);
    } else {
      errors = [];
    }

    // In groups, we don't treat unregistered users as a user-visible
    //   error. The message will look successful, but the details
    //   screen will show that we didn't send to these unregistered users.
    const errorsToSave: Array<CustomError> = [];

    let hadSignedPreKeyRotationError = false;
    errors.forEach(error => {
      const conversation =
        window.ConversationController.get(error.identifier) ||
        window.ConversationController.get(error.number);

      if (conversation && !saveErrors && sendIsFinal) {
        const previousSendState = getOwn(
          sendStateByConversationId,
          conversation.id
        );
        if (previousSendState) {
          sendStateByConversationId[conversation.id] = sendStateReducer(
            previousSendState,
            {
              type: SendActionType.Failed,
              updatedAt: Date.now(),
            }
          );
          this.notifyStorySendFailed();
        }
      }

      let shouldSaveError = true;
      switch (error.name) {
        case 'SignedPreKeyRotationError':
          hadSignedPreKeyRotationError = true;
          break;
        case 'OutgoingIdentityKeyError': {
          if (conversation) {
            promises.push(conversation.getProfiles());
          }
          break;
        }
        case 'UnregisteredUserError':
          if (conversation && isGroup(conversation.attributes)) {
            shouldSaveError = false;
          }
          // If we just found out that we couldn't send to a user because they are no
          //   longer registered, we will update our unregistered flag. In groups we
          //   will not event try to send to them for 6 hours. And we will never try
          //   to fetch them on startup again.
          //
          // The way to discover registration once more is:
          //   1) any attempt to send to them in 1:1 conversation
          //   2) the six-hour time period has passed and we send in a group again
          conversation?.setUnregistered();
          break;
        default:
          break;
      }

      if (shouldSaveError) {
        errorsToSave.push(error);
      }
    });

    if (hadSignedPreKeyRotationError) {
      promises.push(
        window.getAccountManager().rotateSignedPreKey(UUIDKind.ACI)
      );
    }

    attributesToUpdate.sendStateByConversationId = sendStateByConversationId;
    // Only update the expirationStartTimestamp if we don't already have one set
    if (!this.get('expirationStartTimestamp')) {
      attributesToUpdate.expirationStartTimestamp = sentToAtLeastOneRecipient
        ? Date.now()
        : undefined;
    }
    attributesToUpdate.unidentifiedDeliveries = union(
      previousUnidentifiedDeliveries,
      newUnidentifiedDeliveries
    );
    // We may overwrite this in the `saveErrors` call below.
    attributesToUpdate.errors = [];

    this.set(attributesToUpdate);
    if (saveErrors) {
      saveErrors(errorsToSave);
    } else {
      // We skip save because we'll save in the next step.
      void this.saveErrors(errorsToSave, { skipSave: true });
    }

    if (!this.doNotSave) {
      await window.Signal.Data.saveMessage(this.attributes, {
        ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
      });
    }

    updateLeftPane();

    if (sentToAtLeastOneRecipient && !this.doNotSendSyncMessage) {
      promises.push(this.sendSyncMessage());
    }

    await Promise.all(promises);

    const isTotalSuccess: boolean =
      result.success && !this.get('errors')?.length;
    if (isTotalSuccess) {
      delete this.cachedOutgoingContactData;
      delete this.cachedOutgoingPreviewData;
      delete this.cachedOutgoingQuoteData;
      delete this.cachedOutgoingStickerData;
    }

    updateLeftPane();
  }

  async sendSyncMessageOnly(
    dataMessage: Uint8Array,
    saveErrors?: (errors: Array<Error>) => void
  ): Promise<CallbackResultType | void> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conv = this.getConversation()!;
    this.set({ dataMessage });

    const updateLeftPane = conv?.debouncedUpdateLastMessage;

    try {
      this.set({
        // This is the same as a normal send()
        expirationStartTimestamp: Date.now(),
        errors: [],
      });
      const result = await this.sendSyncMessage();
      this.set({
        // We have to do this afterward, since we didn't have a previous send!
        unidentifiedDeliveries:
          result && result.unidentifiedDeliveries
            ? result.unidentifiedDeliveries
            : undefined,
      });
      return result;
    } catch (error) {
      const resultErrors = error?.errors;
      const errors = Array.isArray(resultErrors)
        ? resultErrors
        : [new Error('Unknown error')];
      if (saveErrors) {
        saveErrors(errors);
      } else {
        // We don't save because we're about to save below.
        void this.saveErrors(errors, { skipSave: true });
      }
      throw error;
    } finally {
      await window.Signal.Data.saveMessage(this.attributes, {
        ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
      });

      if (updateLeftPane) {
        updateLeftPane();
      }
    }
  }

  async sendSyncMessage(): Promise<CallbackResultType | void> {
    const ourConversation =
      window.ConversationController.getOurConversationOrThrow();
    const sendOptions = await getSendOptions(ourConversation.attributes, {
      syncMessage: true,
    });

    if (window.ConversationController.areWePrimaryDevice()) {
      log.warn(
        'sendSyncMessage: We are primary device; not sending sync message'
      );
      this.set({ dataMessage: undefined });
      return;
    }

    const { messaging } = window.textsecure;
    if (!messaging) {
      throw new Error('sendSyncMessage: messaging not available!');
    }

    this.syncPromise = this.syncPromise || Promise.resolve();
    const next = async () => {
      const dataMessage = this.get('dataMessage');
      if (!dataMessage) {
        return;
      }
      const isUpdate = Boolean(this.get('synced'));
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const conv = this.getConversation()!;

      const sendEntries = Object.entries(
        this.get('sendStateByConversationId') || {}
      );
      const sentEntries = filter(sendEntries, ([_conversationId, { status }]) =>
        isSent(status)
      );
      const allConversationIdsSentTo = map(
        sentEntries,
        ([conversationId]) => conversationId
      );
      const conversationIdsSentTo = filter(
        allConversationIdsSentTo,
        conversationId => conversationId !== ourConversation.id
      );

      const unidentifiedDeliveries = this.get('unidentifiedDeliveries') || [];
      const maybeConversationsWithSealedSender = map(
        unidentifiedDeliveries,
        identifier => window.ConversationController.get(identifier)
      );
      const conversationsWithSealedSender = filter(
        maybeConversationsWithSealedSender,
        isNotNil
      );
      const conversationIdsWithSealedSender = new Set(
        map(conversationsWithSealedSender, c => c.id)
      );

      const isEditedMessage = Boolean(this.get('editHistory'));
      const mainMessageTimestamp = this.get('sent_at') || this.get('timestamp');
      const timestamp =
        this.get('editMessageTimestamp') || mainMessageTimestamp;

      return handleMessageSend(
        messaging.sendSyncMessage({
          encodedDataMessage: dataMessage,
          editedMessageTimestamp: isEditedMessage
            ? mainMessageTimestamp
            : undefined,
          timestamp,
          destination: conv.get('e164'),
          destinationUuid: conv.get('uuid'),
          expirationStartTimestamp:
            this.get('expirationStartTimestamp') || null,
          conversationIdsSentTo,
          conversationIdsWithSealedSender,
          isUpdate,
          options: sendOptions,
          urgent: false,
        }),
        // Note: in some situations, for doNotSave messages, the message has no
        //   id, so we provide an empty array here.
        { messageIds: this.id ? [this.id] : [], sendType: 'sentSync' }
      ).then(async result => {
        let newSendStateByConversationId: undefined | SendStateByConversationId;
        const sendStateByConversationId =
          this.get('sendStateByConversationId') || {};
        const ourOldSendState = getOwn(
          sendStateByConversationId,
          ourConversation.id
        );
        if (ourOldSendState) {
          const ourNewSendState = sendStateReducer(ourOldSendState, {
            type: SendActionType.Sent,
            updatedAt: Date.now(),
          });
          if (ourNewSendState !== ourOldSendState) {
            newSendStateByConversationId = {
              ...sendStateByConversationId,
              [ourConversation.id]: ourNewSendState,
            };
          }
        }

        this.set({
          synced: true,
          dataMessage: null,
          ...(newSendStateByConversationId
            ? { sendStateByConversationId: newSendStateByConversationId }
            : {}),
        });

        // Return early, skip the save
        if (this.doNotSave) {
          return result;
        }

        await window.Signal.Data.saveMessage(this.attributes, {
          ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
        });
        return result;
      });
    };

    this.syncPromise = this.syncPromise.then(next, next);

    return this.syncPromise;
  }

  hasRequiredAttachmentDownloads(): boolean {
    const attachments: ReadonlyArray<AttachmentType> =
      this.get('attachments') || [];

    const hasLongMessageAttachments = attachments.some(attachment => {
      return MIME.isLongMessage(attachment.contentType);
    });

    if (hasLongMessageAttachments) {
      return true;
    }

    const sticker = this.get('sticker');
    if (sticker) {
      return !sticker.data || !sticker.data.path;
    }

    return false;
  }

  hasAttachmentDownloads(): boolean {
    return hasAttachmentDownloads(this.attributes);
  }

  async queueAttachmentDownloads(): Promise<boolean> {
    const value = await queueAttachmentDownloads(this.attributes);
    if (!value) {
      return false;
    }

    this.set(value);
    return true;
  }

  markAttachmentAsCorrupted(attachment: AttachmentType): void {
    if (!attachment.path) {
      throw new Error(
        "Attachment can't be marked as corrupted because it wasn't loaded"
      );
    }

    // We intentionally don't check in quotes/stickers/contacts/... here,
    // because this function should be called only for something that can
    // be displayed as a generic attachment.
    const attachments: ReadonlyArray<AttachmentType> =
      this.get('attachments') || [];

    let changed = false;
    const newAttachments = attachments.map(existing => {
      if (existing.path !== attachment.path) {
        return existing;
      }
      changed = true;

      return {
        ...existing,
        isCorrupted: true,
      };
    });

    if (!changed) {
      throw new Error(
        "Attachment can't be marked as corrupted because it wasn't found"
      );
    }

    log.info('markAttachmentAsCorrupted: marking an attachment as corrupted');

    this.set({
      attachments: newAttachments,
    });
  }

  async copyFromQuotedMessage(
    quote: ProcessedQuote | undefined,
    conversationId: string
  ): Promise<QuotedMessageType | undefined> {
    if (!quote) {
      return undefined;
    }

    const { id } = quote;
    strictAssert(id, 'Quote must have an id');

    const result: QuotedMessageType = {
      ...quote,

      id,

      attachments: quote.attachments.slice(),
      bodyRanges: quote.bodyRanges?.slice(),

      // Just placeholder values for the fields
      referencedMessageNotFound: false,
      isGiftBadge: quote.type === Proto.DataMessage.Quote.Type.GIFT_BADGE,
      isViewOnce: false,
      messageId: '',
    };

    const inMemoryMessages = window.MessageController.filterBySentAt(id);
    const matchingMessage = find(inMemoryMessages, item =>
      isQuoteAMatch(item.attributes, conversationId, result)
    );

    let queryMessage: undefined | MessageModel;

    if (matchingMessage) {
      queryMessage = matchingMessage;
    } else {
      log.info('copyFromQuotedMessage: db lookup needed', id);
      const messages = await window.Signal.Data.getMessagesBySentAt(id);
      const found = messages.find(item =>
        isQuoteAMatch(item, conversationId, result)
      );

      if (!found) {
        result.referencedMessageNotFound = true;
        return result;
      }

      queryMessage = window.MessageController.register(found.id, found);
    }

    if (queryMessage) {
      await this.copyQuoteContentFromOriginal(queryMessage, result);
    }

    return result;
  }

  async copyQuoteContentFromOriginal(
    originalMessage: MessageModel,
    quote: QuotedMessageType
  ): Promise<void> {
    const { attachments } = quote;
    const firstAttachment = attachments ? attachments[0] : undefined;

    if (messageHasPaymentEvent(originalMessage.attributes)) {
      // eslint-disable-next-line no-param-reassign
      quote.payment = originalMessage.get('payment');
    }

    if (isTapToView(originalMessage.attributes)) {
      // eslint-disable-next-line no-param-reassign
      quote.text = undefined;
      // eslint-disable-next-line no-param-reassign
      quote.attachments = [
        {
          contentType: MIME.IMAGE_JPEG,
        },
      ];
      // eslint-disable-next-line no-param-reassign
      quote.isViewOnce = true;

      return;
    }

    const isMessageAGiftBadge = isGiftBadge(originalMessage.attributes);
    if (isMessageAGiftBadge !== quote.isGiftBadge) {
      log.warn(
        `copyQuoteContentFromOriginal: Quote.isGiftBadge: ${quote.isGiftBadge}, isGiftBadge(message): ${isMessageAGiftBadge}`
      );
      // eslint-disable-next-line no-param-reassign
      quote.isGiftBadge = isMessageAGiftBadge;
    }
    if (isMessageAGiftBadge) {
      // eslint-disable-next-line no-param-reassign
      quote.text = undefined;
      // eslint-disable-next-line no-param-reassign
      quote.attachments = [];

      return;
    }

    // eslint-disable-next-line no-param-reassign
    quote.isViewOnce = false;

    // eslint-disable-next-line no-param-reassign
    quote.text = getQuoteBodyText(originalMessage.attributes, quote.id);

    // eslint-disable-next-line no-param-reassign
    quote.bodyRanges = originalMessage.attributes.bodyRanges;

    if (firstAttachment) {
      firstAttachment.thumbnail = null;
    }

    if (
      !firstAttachment ||
      !firstAttachment.contentType ||
      (!GoogleChrome.isImageTypeSupported(
        stringToMIMEType(firstAttachment.contentType)
      ) &&
        !GoogleChrome.isVideoTypeSupported(
          stringToMIMEType(firstAttachment.contentType)
        ))
    ) {
      return;
    }

    try {
      const schemaVersion = originalMessage.get('schemaVersion');
      if (
        schemaVersion &&
        schemaVersion < TypedMessage.VERSION_NEEDED_FOR_DISPLAY
      ) {
        const upgradedMessage = await upgradeMessageSchema(
          originalMessage.attributes
        );
        originalMessage.set(upgradedMessage);
        await window.Signal.Data.saveMessage(upgradedMessage, {
          ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
        });
      }
    } catch (error) {
      log.error(
        'Problem upgrading message quoted message from database',
        Errors.toLogFormat(error)
      );
      return;
    }

    const queryAttachments = originalMessage.get('attachments') || [];
    if (queryAttachments.length > 0) {
      const queryFirst = queryAttachments[0];
      const { thumbnail } = queryFirst;

      if (thumbnail && thumbnail.path) {
        firstAttachment.thumbnail = {
          ...thumbnail,
          copied: true,
        };
      }
    }

    const queryPreview = originalMessage.get('preview') || [];
    if (queryPreview.length > 0) {
      const queryFirst = queryPreview[0];
      const { image } = queryFirst;

      if (image && image.path) {
        firstAttachment.thumbnail = {
          ...image,
          copied: true,
        };
      }
    }

    const sticker = originalMessage.get('sticker');
    if (sticker && sticker.data && sticker.data.path) {
      firstAttachment.thumbnail = {
        ...sticker.data,
        copied: true,
      };
    }
  }

  async handleDataMessage(
    initialMessage: ProcessedDataMessage,
    confirm: () => void,
    options: { data?: SentEventData } = {}
  ): Promise<void> {
    const { data } = options;

    // This function is called from the background script in a few scenarios:
    //   1. on an incoming message
    //   2. on a sent message sync'd from another device
    //   3. in rare cases, an incoming message can be retried, though it will
    //      still go through one of the previous two codepaths
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const message = this;
    const source = message.get('source');
    const sourceUuid = message.get('sourceUuid');
    const type = message.get('type');
    const conversationId = message.get('conversationId');

    const fromContact = getContact(this.attributes);
    if (fromContact) {
      fromContact.setRegistered();
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const conversation = window.ConversationController.get(conversationId)!;
    const idLog = `handleDataMessage/${conversation.idForLogging()} ${message.idForLogging()}`;
    await conversation.queueJob(idLog, async () => {
      log.info(`${idLog}: starting processing in queue`);

      // First, check for duplicates. If we find one, stop processing here.
      const inMemoryMessage = window.MessageController.findBySender(
        this.getSenderIdentifier()
      )?.attributes;
      if (inMemoryMessage) {
        log.info(`${idLog}: cache hit`, this.getSenderIdentifier());
      } else {
        log.info(
          `${idLog}: duplicate check db lookup needed`,
          this.getSenderIdentifier()
        );
      }
      const existingMessage =
        inMemoryMessage || (await getMessageBySender(this.attributes));
      const isUpdate = Boolean(data && data.isRecipientUpdate);

      const isDuplicateMessage =
        existingMessage &&
        (type === 'incoming' ||
          (type === 'story' &&
            existingMessage.storyDistributionListId ===
              this.attributes.storyDistributionListId));

      if (isDuplicateMessage) {
        log.warn(`${idLog}: Received duplicate message`, this.idForLogging());
        confirm();
        return;
      }
      if (type === 'outgoing') {
        if (isUpdate && existingMessage) {
          log.info(
            `${idLog}: Updating message ${message.idForLogging()} with received transcript`
          );

          const toUpdate = window.MessageController.register(
            existingMessage.id,
            existingMessage
          );

          const unidentifiedDeliveriesSet = new Set<string>(
            toUpdate.get('unidentifiedDeliveries') ?? []
          );
          const sendStateByConversationId = {
            ...(toUpdate.get('sendStateByConversationId') || {}),
          };

          const unidentifiedStatus: Array<ProcessedUnidentifiedDeliveryStatus> =
            data && Array.isArray(data.unidentifiedStatus)
              ? data.unidentifiedStatus
              : [];

          unidentifiedStatus.forEach(
            ({ destinationUuid, destination, unidentified }) => {
              const identifier = destinationUuid || destination;
              if (!identifier) {
                return;
              }

              const { conversation: destinationConversation } =
                window.ConversationController.maybeMergeContacts({
                  aci: destinationUuid,
                  e164: destination || undefined,
                  reason: `handleDataMessage(${initialMessage.timestamp})`,
                });
              if (!destinationConversation) {
                return;
              }

              const updatedAt: number =
                data && isNormalNumber(data.timestamp)
                  ? data.timestamp
                  : Date.now();

              const previousSendState = getOwn(
                sendStateByConversationId,
                destinationConversation.id
              );
              sendStateByConversationId[destinationConversation.id] =
                previousSendState
                  ? sendStateReducer(previousSendState, {
                      type: SendActionType.Sent,
                      updatedAt,
                    })
                  : {
                      status: SendStatus.Sent,
                      updatedAt,
                    };

              if (unidentified) {
                unidentifiedDeliveriesSet.add(identifier);
              }
            }
          );

          toUpdate.set({
            sendStateByConversationId,
            unidentifiedDeliveries: [...unidentifiedDeliveriesSet],
          });
          await window.Signal.Data.saveMessage(toUpdate.attributes, {
            ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
          });

          confirm();
          return;
        }
        if (isUpdate) {
          log.warn(
            `${idLog}: Received update transcript, but no existing entry for message ${message.idForLogging()}. Dropping.`
          );

          confirm();
          return;
        }
        if (existingMessage) {
          log.warn(
            `${idLog}: Received duplicate transcript for message ${message.idForLogging()}, but it was not an update transcript. Dropping.`
          );

          confirm();
          return;
        }
      }

      // GroupV2

      if (initialMessage.groupV2) {
        if (isGroupV1(conversation.attributes)) {
          // If we received a GroupV2 message in a GroupV1 group, we migrate!

          const { revision, groupChange } = initialMessage.groupV2;
          await window.Signal.Groups.respondToGroupV2Migration({
            conversation,
            groupChange: groupChange
              ? {
                  base64: groupChange,
                  isTrusted: false,
                }
              : undefined,
            newRevision: revision,
            receivedAt: message.get('received_at'),
            sentAt: message.get('sent_at'),
          });
        } else if (
          initialMessage.groupV2.masterKey &&
          initialMessage.groupV2.secretParams &&
          initialMessage.groupV2.publicParams
        ) {
          // Repair core GroupV2 data if needed
          await conversation.maybeRepairGroupV2({
            masterKey: initialMessage.groupV2.masterKey,
            secretParams: initialMessage.groupV2.secretParams,
            publicParams: initialMessage.groupV2.publicParams,
          });

          const existingRevision = conversation.get('revision');
          const isFirstUpdate = !isNumber(existingRevision);

          // Standard GroupV2 modification codepath
          const isV2GroupUpdate =
            initialMessage.groupV2 &&
            isNumber(initialMessage.groupV2.revision) &&
            (isFirstUpdate ||
              initialMessage.groupV2.revision > existingRevision);

          if (isV2GroupUpdate && initialMessage.groupV2) {
            const { revision, groupChange } = initialMessage.groupV2;
            try {
              await window.Signal.Groups.maybeUpdateGroup({
                conversation,
                groupChange: groupChange
                  ? {
                      base64: groupChange,
                      isTrusted: false,
                    }
                  : undefined,
                newRevision: revision,
                receivedAt: message.get('received_at'),
                sentAt: message.get('sent_at'),
              });
            } catch (error) {
              const errorText = Errors.toLogFormat(error);
              log.error(
                `${idLog}: Failed to process group update as part of message ${message.idForLogging()}: ${errorText}`
              );
              throw error;
            }
          }
        }
      }

      const ourACI = window.textsecure.storage.user.getCheckedUuid(
        UUIDKind.ACI
      );
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const sender = window.ConversationController.lookupOrCreate({
        e164: source,
        uuid: sourceUuid,
        reason: 'handleDataMessage',
      })!;
      const hasGroupV2Prop = Boolean(initialMessage.groupV2);

      // Drop if from blocked user. Only GroupV2 messages should need to be dropped here.
      const isBlocked =
        (source && window.storage.blocked.isBlocked(source)) ||
        (sourceUuid && window.storage.blocked.isUuidBlocked(sourceUuid));
      if (isBlocked) {
        log.info(
          `${idLog}: Dropping message from blocked sender. hasGroupV2Prop: ${hasGroupV2Prop}`
        );

        confirm();
        return;
      }

      const areWeMember =
        !conversation.get('left') && conversation.hasMember(ourACI);

      // Drop an incoming GroupV2 message if we or the sender are not part of the group
      //   after applying the message's associated group changes.
      if (
        type === 'incoming' &&
        !isDirectConversation(conversation.attributes) &&
        hasGroupV2Prop &&
        (!areWeMember ||
          (sourceUuid && !conversation.hasMember(new UUID(sourceUuid))))
      ) {
        log.warn(
          `${idLog}: Received message destined for group, which we or the sender are not a part of. Dropping.`
        );
        confirm();
        return;
      }

      // We drop incoming messages for v1 groups we already know about, which we're not
      //   a part of, except for group updates. Because group v1 updates haven't been
      //   applied by this point.
      // Note: if we have no information about a group at all, we will accept those
      //   messages. We detect that via a missing 'members' field.
      if (
        type === 'incoming' &&
        !isDirectConversation(conversation.attributes) &&
        !hasGroupV2Prop &&
        conversation.get('members') &&
        !areWeMember
      ) {
        log.warn(
          `Received message destined for group ${conversation.idForLogging()}, which we're not a part of. Dropping.`
        );
        confirm();
        return;
      }

      // Drop incoming messages to announcement only groups where sender is not admin
      if (
        conversation.get('announcementsOnly') &&
        !conversation.isAdmin(UUID.checkedLookup(sender?.id))
      ) {
        confirm();
        return;
      }

      const messageId = message.get('id') || UUID.generate().toString();

      // Send delivery receipts, but only for non-story sealed sender messages
      //   and not for messages from unaccepted conversations
      if (
        type === 'incoming' &&
        this.get('unidentifiedDeliveryReceived') &&
        !hasErrors(this.attributes) &&
        conversation.getAccepted()
      ) {
        // Note: We both queue and batch because we want to wait until we are done
        //   processing incoming messages to start sending outgoing delivery receipts.
        //   The queue can be paused easily.
        drop(
          window.Whisper.deliveryReceiptQueue.add(() => {
            window.Whisper.deliveryReceiptBatcher.add({
              messageId,
              conversationId,
              senderE164: source,
              senderUuid: sourceUuid,
              timestamp: this.get('sent_at'),
              isDirectConversation: isDirectConversation(
                conversation.attributes
              ),
            });
          })
        );
      }

      const [quote, storyQuote] = await Promise.all([
        this.copyFromQuotedMessage(initialMessage.quote, conversation.id),
        findStoryMessage(conversation.id, initialMessage.storyContext),
      ]);

      if (initialMessage.storyContext && !storyQuote) {
        if (!isDirectConversation(conversation.attributes)) {
          log.warn(
            `${idLog}: Received storyContext message in group but no matching story. Dropping.`
          );

          confirm();
          return;
        }
        log.warn(
          `${idLog}: Received 1:1 storyContext message but no matching story. We'll try processing this message again later.`
        );

        return;
      }

      if (storyQuote) {
        const sendStateByConversationId =
          storyQuote.get('sendStateByConversationId') || {};
        const sendState = sendStateByConversationId[sender.id];

        const storyQuoteIsFromSelf =
          storyQuote.get('sourceUuid') ===
          window.storage.user.getCheckedUuid().toString();

        if (storyQuoteIsFromSelf && !sendState) {
          log.warn(
            `${idLog}: Received storyContext message but sender was not in sendStateByConversationId. Dropping.`
          );

          confirm();
          return;
        }

        if (
          storyQuoteIsFromSelf &&
          sendState.isAllowedToReplyToStory === false &&
          isDirectConversation(conversation.attributes)
        ) {
          log.warn(
            `${idLog}: Received 1:1 storyContext message but sender is not allowed to reply. Dropping.`
          );

          confirm();
          return;
        }

        const storyDistributionListId = storyQuote.get(
          'storyDistributionListId'
        );

        if (storyDistributionListId) {
          const storyDistribution =
            await dataInterface.getStoryDistributionWithMembers(
              storyDistributionListId
            );

          if (!storyDistribution) {
            log.warn(
              `${idLog}: Received storyContext message for story with no associated distribution list. Dropping.`
            );

            confirm();
            return;
          }

          if (!storyDistribution.allowsReplies) {
            log.warn(
              `${idLog}: Received storyContext message but distribution list does not allow replies. Dropping.`
            );

            confirm();
            return;
          }
        }
      }

      const withQuoteReference = {
        ...message.attributes,
        ...initialMessage,
        quote,
        storyId: storyQuote?.id,
      };

      // There are type conflicts between ModelAttributesType and protos passed in here
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dataMessage = await upgradeMessageSchema(withQuoteReference as any);

      const isGroupStoryReply =
        isGroup(conversation.attributes) && dataMessage.storyId;

      try {
        const now = new Date().getTime();

        const urls = LinkPreview.findLinks(dataMessage.body || '');
        const incomingPreview = dataMessage.preview || [];
        const preview = incomingPreview.filter((item: LinkPreviewType) => {
          if (!item.image && !item.title) {
            return false;
          }
          // Story link previews don't have to correspond to links in the
          // message body.
          if (isStory(message.attributes)) {
            return true;
          }
          return (
            urls.includes(item.url) && LinkPreview.shouldPreviewHref(item.url)
          );
        });
        if (preview.length < incomingPreview.length) {
          log.info(
            `${message.idForLogging()}: Eliminated ${
              preview.length - incomingPreview.length
            } previews with invalid urls'`
          );
        }

        message.set({
          id: messageId,
          attachments: dataMessage.attachments,
          body: dataMessage.body,
          bodyRanges: dataMessage.bodyRanges,
          contact: dataMessage.contact,
          conversationId: conversation.id,
          decrypted_at: now,
          errors: [],
          flags: dataMessage.flags,
          giftBadge: initialMessage.giftBadge,
          hasAttachments: dataMessage.hasAttachments,
          hasFileAttachments: dataMessage.hasFileAttachments,
          hasVisualMediaAttachments: dataMessage.hasVisualMediaAttachments,
          isViewOnce: Boolean(dataMessage.isViewOnce),
          preview,
          requiredProtocolVersion:
            dataMessage.requiredProtocolVersion ||
            this.INITIAL_PROTOCOL_VERSION,
          supportedVersionAtReceive: this.CURRENT_PROTOCOL_VERSION,
          payment: dataMessage.payment,
          quote: dataMessage.quote,
          schemaVersion: dataMessage.schemaVersion,
          sticker: dataMessage.sticker,
          storyId: dataMessage.storyId,
        });

        if (storyQuote) {
          await this.hydrateStoryContext(storyQuote.attributes);
        }

        const isSupported = !isUnsupportedMessage(message.attributes);
        if (!isSupported) {
          await message.eraseContents();
        }

        if (isSupported) {
          const attributes = {
            ...conversation.attributes,
          };

          // Drop empty messages after. This needs to happen after the initial
          // message.set call and after GroupV1 processing to make sure all possible
          // properties are set before we determine that a message is empty.
          if (message.isEmpty()) {
            log.info(`${idLog}: Dropping empty message`);
            confirm();
            return;
          }

          if (isStory(message.attributes)) {
            attributes.hasPostedStory = true;
          } else {
            attributes.active_at = now;
          }

          conversation.set(attributes);

          // Sync group story reply expiration timers with the parent story's
          // expiration timer
          if (isGroupStoryReply && storyQuote) {
            message.set({
              expireTimer: storyQuote.get('expireTimer'),
              expirationStartTimestamp: storyQuote.get(
                'expirationStartTimestamp'
              ),
            });
          }

          if (
            dataMessage.expireTimer &&
            !isExpirationTimerUpdate(dataMessage)
          ) {
            message.set({ expireTimer: dataMessage.expireTimer });
            if (isStory(message.attributes)) {
              log.info(`${idLog}: Starting story expiration`);
              message.set({
                expirationStartTimestamp: dataMessage.timestamp,
              });
            }
          }

          if (!hasGroupV2Prop && !isStory(message.attributes)) {
            if (isExpirationTimerUpdate(message.attributes)) {
              message.set({
                expirationTimerUpdate: {
                  source,
                  sourceUuid,
                  expireTimer: initialMessage.expireTimer,
                },
              });

              if (conversation.get('expireTimer') !== dataMessage.expireTimer) {
                log.info('Incoming expirationTimerUpdate changed timer', {
                  id: conversation.idForLogging(),
                  expireTimer: dataMessage.expireTimer || 'disabled',
                  source: idLog,
                });
                conversation.set({
                  expireTimer: dataMessage.expireTimer,
                });
              }
            }

            // Note: For incoming expire timer updates (not normal messages that come
            //   along with an expireTimer), the conversation will be updated by this
            //   point and these calls will return early.
            if (dataMessage.expireTimer) {
              void conversation.updateExpirationTimer(dataMessage.expireTimer, {
                source: sourceUuid || source,
                receivedAt: message.get('received_at'),
                receivedAtMS: message.get('received_at_ms'),
                sentAt: message.get('sent_at'),
                fromGroupUpdate: isGroupUpdate(message.attributes),
                reason: idLog,
              });
            } else if (
              // We won't turn off timers for these kinds of messages:
              !isGroupUpdate(message.attributes) &&
              !isEndSession(message.attributes)
            ) {
              void conversation.updateExpirationTimer(undefined, {
                source: sourceUuid || source,
                receivedAt: message.get('received_at'),
                receivedAtMS: message.get('received_at_ms'),
                sentAt: message.get('sent_at'),
                reason: idLog,
              });
            }
          }

          if (initialMessage.profileKey) {
            const { profileKey } = initialMessage;
            if (
              source === window.textsecure.storage.user.getNumber() ||
              sourceUuid ===
                window.textsecure.storage.user.getUuid()?.toString()
            ) {
              conversation.set({ profileSharing: true });
            } else if (isDirectConversation(conversation.attributes)) {
              void conversation.setProfileKey(profileKey);
            } else {
              const local = window.ConversationController.lookupOrCreate({
                e164: source,
                uuid: sourceUuid,
                reason: 'handleDataMessage:setProfileKey',
              });
              void local?.setProfileKey(profileKey);
            }
          }

          if (isTapToView(message.attributes) && type === 'outgoing') {
            await message.eraseContents();
          }

          if (
            type === 'incoming' &&
            isTapToView(message.attributes) &&
            !message.isValidTapToView()
          ) {
            log.warn(
              `${idLog}: Received tap to view message with invalid data. Erasing contents.`
            );
            message.set({
              isTapToViewInvalid: true,
            });
            await message.eraseContents();
          }
        }

        const conversationTimestamp = conversation.get('timestamp');
        if (
          !isStory(message.attributes) &&
          !isGroupStoryReply &&
          (!conversationTimestamp ||
            message.get('sent_at') > conversationTimestamp) &&
          messageHasPaymentEvent(message.attributes)
        ) {
          conversation.set({
            lastMessage: message.getNotificationText(),
            lastMessageAuthor: message.getAuthorText(),
            timestamp: message.get('sent_at'),
          });
        }

        window.MessageController.register(message.id, message);
        conversation.incrementMessageCount();

        // If we sent a message in a given conversation, unarchive it!
        if (type === 'outgoing') {
          conversation.setArchived(false);
        }

        window.Signal.Data.updateConversation(conversation.attributes);

        const reduxState = window.reduxStore.getState();

        const giftBadge = message.get('giftBadge');
        if (giftBadge) {
          const { level } = giftBadge;
          const { updatesUrl } = window.SignalContext.config;
          strictAssert(
            typeof updatesUrl === 'string',
            'getProfile: expected updatesUrl to be a defined string'
          );
          const userLanguages = getUserLanguages(
            window.getPreferredSystemLocales(),
            window.getResolvedMessagesLocale()
          );
          const { messaging } = window.textsecure;
          if (!messaging) {
            throw new Error(`${idLog}: messaging is not available`);
          }
          const response = await messaging.server.getBoostBadgesFromServer(
            userLanguages
          );
          const boostBadgesByLevel = parseBoostBadgeListFromServer(
            response,
            updatesUrl
          );
          const badge = boostBadgesByLevel[level];
          if (!badge) {
            log.error(
              `${idLog}: gift badge with level ${level} not found on server`
            );
          } else {
            await window.reduxActions.badges.updateOrCreate([badge]);
            giftBadge.id = badge.id;
          }
        }

        // Only queue attachments for downloads if this is a story or
        // outgoing message or we've accepted the conversation
        const attachments = this.get('attachments') || [];

        let queueStoryForDownload = false;
        if (isStory(message.attributes)) {
          const isShowingStories = shouldShowStoriesView(reduxState);

          queueStoryForDownload =
            isShowingStories ||
            (await shouldDownloadStory(conversation.attributes));
        }

        const shouldHoldOffDownload =
          (isStory(message.attributes) && !queueStoryForDownload) ||
          (!isStory(message.attributes) &&
            (isImage(attachments) || isVideo(attachments)) &&
            isInCall(reduxState));

        if (
          this.hasAttachmentDownloads() &&
          (conversation.getAccepted() || isOutgoing(message.attributes)) &&
          !shouldHoldOffDownload
        ) {
          if (shouldUseAttachmentDownloadQueue()) {
            addToAttachmentDownloadQueue(idLog, message);
          } else {
            await message.queueAttachmentDownloads();
          }
        }

        const isFirstRun = true;
        await this.modifyTargetMessage(conversation, isFirstRun);

        log.info(`${idLog}: Batching save`);
        void this.saveAndNotify(conversation, confirm);
      } catch (error) {
        const errorForLog = Errors.toLogFormat(error);
        log.error(`${idLog}: error:`, errorForLog);
        throw error;
      }
    });
  }

  async saveAndNotify(
    conversation: ConversationModel,
    confirm: () => void
  ): Promise<void> {
    await saveNewMessageBatcher.add(this.attributes);

    log.info('Message saved', this.get('sent_at'));

    conversation.trigger('newmessage', this);

    const isFirstRun = false;
    await this.modifyTargetMessage(conversation, isFirstRun);

    if (await shouldReplyNotifyUser(this, conversation)) {
      await conversation.notify(this);
    }

    // Increment the sent message count if this is an outgoing message
    if (this.get('type') === 'outgoing') {
      conversation.incrementSentMessageCount();
    }

    window.Whisper.events.trigger('incrementProgress');
    confirm();

    if (!isStory(this.attributes)) {
      drop(
        conversation.queueJob('updateUnread', () => conversation.updateUnread())
      );
    }
  }

  // This function is called twice - once from handleDataMessage, and then again from
  //    saveAndNotify, a function called at the end of handleDataMessage as a cleanup for
  //    any missed out-of-order events.
  async modifyTargetMessage(
    conversation: ConversationModel,
    isFirstRun: boolean
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const message = this;
    const type = message.get('type');
    let changed = false;
    const ourUuid = window.textsecure.storage.user.getCheckedUuid().toString();
    const sourceUuid = getSourceUuid(message.attributes);

    if (type === 'outgoing' || (type === 'story' && ourUuid === sourceUuid)) {
      const sendActions = MessageReceipts.getSingleton()
        .forMessage(message)
        .map(receipt => {
          let sendActionType: SendActionType;
          const receiptType = receipt.get('type');
          switch (receiptType) {
            case MessageReceiptType.Delivery:
              sendActionType = SendActionType.GotDeliveryReceipt;
              break;
            case MessageReceiptType.Read:
              sendActionType = SendActionType.GotReadReceipt;
              break;
            case MessageReceiptType.View:
              sendActionType = SendActionType.GotViewedReceipt;
              break;
            default:
              throw missingCaseError(receiptType);
          }

          return {
            destinationConversationId: receipt.get('sourceConversationId'),
            action: {
              type: sendActionType,
              updatedAt: receipt.get('receiptTimestamp'),
            },
          };
        });

      const oldSendStateByConversationId =
        this.get('sendStateByConversationId') || {};

      const newSendStateByConversationId = reduce(
        sendActions,
        (
          result: SendStateByConversationId,
          { destinationConversationId, action }
        ) => {
          const oldSendState = getOwn(result, destinationConversationId);
          if (!oldSendState) {
            log.warn(
              `Got a receipt for a conversation (${destinationConversationId}), but we have no record of sending to them`
            );
            return result;
          }

          const newSendState = sendStateReducer(oldSendState, action);
          return {
            ...result,
            [destinationConversationId]: newSendState,
          };
        },
        oldSendStateByConversationId
      );

      if (
        !isEqual(oldSendStateByConversationId, newSendStateByConversationId)
      ) {
        message.set('sendStateByConversationId', newSendStateByConversationId);
        changed = true;
      }
    }

    if (type === 'incoming') {
      // In a followup (see DESKTOP-2100), we want to make `ReadSyncs#forMessage` return
      //   an array, not an object. This array wrapping makes that future a bit easier.
      const readSync = ReadSyncs.getSingleton().forMessage(message);
      const readSyncs = readSync ? [readSync] : [];

      const viewSyncs = ViewSyncs.getSingleton().forMessage(message);

      const isGroupStoryReply =
        isGroup(conversation.attributes) && message.get('storyId');

      if (readSyncs.length !== 0 || viewSyncs.length !== 0) {
        const markReadAt = Math.min(
          Date.now(),
          ...readSyncs.map(sync => sync.get('readAt')),
          ...viewSyncs.map(sync => sync.get('viewedAt'))
        );

        if (message.get('expireTimer')) {
          const existingExpirationStartTimestamp = message.get(
            'expirationStartTimestamp'
          );
          message.set(
            'expirationStartTimestamp',
            Math.min(existingExpirationStartTimestamp ?? Date.now(), markReadAt)
          );
          changed = true;
        }

        let newReadStatus: ReadStatus.Read | ReadStatus.Viewed;
        if (viewSyncs.length) {
          newReadStatus = ReadStatus.Viewed;
        } else {
          strictAssert(
            readSyncs.length !== 0,
            'Should have either view or read syncs'
          );
          newReadStatus = ReadStatus.Read;
        }

        message.set({
          readStatus: newReadStatus,
          seenStatus: SeenStatus.Seen,
        });
        changed = true;

        this.pendingMarkRead = Math.min(
          this.pendingMarkRead ?? Date.now(),
          markReadAt
        );
      } else if (
        isFirstRun &&
        !isGroupStoryReply &&
        canConversationBeUnarchived(conversation.attributes)
      ) {
        conversation.setArchived(false);
      }

      if (!isFirstRun && this.pendingMarkRead) {
        const markReadAt = this.pendingMarkRead;
        this.pendingMarkRead = undefined;

        // This is primarily to allow the conversation to mark all older
        // messages as read, as is done when we receive a read sync for
        // a message we already know about.
        //
        // We run this when `isFirstRun` is false so that it triggers when the
        // message and the other ones accompanying it in the batch are fully in
        // the database.
        void message.getConversation()?.onReadMessage(message, markReadAt);
      }

      // Check for out-of-order view once open syncs
      if (isTapToView(message.attributes)) {
        const viewOnceOpenSync =
          ViewOnceOpenSyncs.getSingleton().forMessage(message);
        if (viewOnceOpenSync) {
          await message.markViewOnceMessageViewed({ fromSync: true });
          changed = true;
        }
      }
    }

    if (isStory(message.attributes)) {
      const viewSyncs = ViewSyncs.getSingleton().forMessage(message);

      if (viewSyncs.length !== 0) {
        message.set({
          readStatus: ReadStatus.Viewed,
          seenStatus: SeenStatus.Seen,
        });
        changed = true;

        const markReadAt = Math.min(
          Date.now(),
          ...viewSyncs.map(sync => sync.get('viewedAt'))
        );
        this.pendingMarkRead = Math.min(
          this.pendingMarkRead ?? Date.now(),
          markReadAt
        );
      }

      if (!message.get('expirationStartTimestamp')) {
        log.info(
          `modifyTargetMessage/${this.idForLogging()}: setting story expiration`,
          {
            expirationStartTimestamp: message.get('timestamp'),
            expireTimer: message.get('expireTimer'),
          }
        );
        message.set('expirationStartTimestamp', message.get('timestamp'));
        changed = true;
      }
    }

    // Does this message have any pending, previously-received associated reactions?
    const reactions = Reactions.getSingleton().forMessage(message);
    await Promise.all(
      reactions.map(async reaction => {
        if (isStory(this.attributes)) {
          // We don't set changed = true here, because we don't modify the original story
          const generatedMessage = reaction.get('storyReactionMessage');
          strictAssert(
            generatedMessage,
            'Story reactions must provide storyReactionMessage'
          );
          await generatedMessage.handleReaction(reaction, {
            storyMessage: this.attributes,
          });
        } else {
          changed = true;
          await message.handleReaction(reaction, { shouldPersist: false });
        }
      })
    );

    // Does this message have any pending, previously-received associated
    // delete for everyone messages?
    const deletes = Deletes.getSingleton().forMessage(message);
    await Promise.all(
      deletes.map(async del => {
        await deleteForEveryone(message, del, false);
        changed = true;
      })
    );

    // We want to make sure the message is saved first before applying any edits
    if (!isFirstRun) {
      const edits = Edits.forMessage(message);
      log.info(
        `modifyTargetMessage/${this.idForLogging()}: ${
          edits.length
        } edits in second run`
      );
      await Promise.all(
        edits.map(editAttributes =>
          conversation.queueJob('modifyTargetMessage/edits', () =>
            handleEditMessage(message.attributes, editAttributes)
          )
        )
      );
    }

    if (changed && !isFirstRun) {
      log.info(
        `modifyTargetMessage/${this.idForLogging()}: Changes in second run; saving.`
      );
      await window.Signal.Data.saveMessage(this.attributes, {
        ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
      });
    }
  }

  async handleReaction(
    reaction: ReactionModel,
    {
      storyMessage,
      shouldPersist = true,
    }: {
      storyMessage?: MessageAttributesType;
      shouldPersist?: boolean;
    } = {}
  ): Promise<void> {
    const { attributes } = this;

    if (this.get('deletedForEveryone')) {
      return;
    }

    // We allow you to react to messages with outgoing errors only if it has sent
    //   successfully to at least one person.
    if (
      hasErrors(attributes) &&
      (isIncoming(attributes) ||
        getMessagePropStatus(
          attributes,
          window.ConversationController.getOurConversationIdOrThrow()
        ) !== 'partial-sent')
    ) {
      return;
    }

    const conversation = this.getConversation();
    if (!conversation) {
      return;
    }

    const isFromThisDevice =
      reaction.get('source') === ReactionSource.FromThisDevice;
    const isFromSync = reaction.get('source') === ReactionSource.FromSync;
    const isFromSomeoneElse =
      reaction.get('source') === ReactionSource.FromSomeoneElse;
    strictAssert(
      isFromThisDevice || isFromSync || isFromSomeoneElse,
      'Reaction can only be from this device, from sync, or from someone else'
    );

    const newReaction: MessageReactionType = {
      emoji: reaction.get('remove') ? undefined : reaction.get('emoji'),
      fromId: reaction.get('fromId'),
      targetAuthorUuid: reaction.get('targetAuthorUuid'),
      targetTimestamp: reaction.get('targetTimestamp'),
      timestamp: reaction.get('timestamp'),
      isSentByConversationId: isFromThisDevice
        ? zipObject(conversation.getMemberConversationIds(), repeat(false))
        : undefined,
    };

    // Reactions to stories are saved as separate messages, and so require a totally
    //   different codepath.
    if (storyMessage) {
      if (isFromThisDevice) {
        log.info(
          'handleReaction: sending story reaction to ' +
            `${getMessageIdForLogging(storyMessage)} from this device`
        );
      } else {
        if (isFromSomeoneElse) {
          log.info(
            'handleReaction: receiving story reaction to ' +
              `${getMessageIdForLogging(storyMessage)} from someone else`
          );
        } else if (isFromSync) {
          log.info(
            'handleReaction: receiving story reaction to ' +
              `${getMessageIdForLogging(storyMessage)} from another device`
          );
        }

        const generatedMessage = reaction.get('storyReactionMessage');
        strictAssert(
          generatedMessage,
          'Story reactions must provide storyReactionMessage'
        );
        const targetConversation = window.ConversationController.get(
          generatedMessage.get('conversationId')
        );
        strictAssert(
          targetConversation,
          'handleReaction: targetConversation not found'
        );

        generatedMessage.set({
          expireTimer: isDirectConversation(targetConversation.attributes)
            ? targetConversation.get('expireTimer')
            : undefined,
          storyId: storyMessage.id,
          storyReaction: {
            emoji: reaction.get('emoji'),
            targetAuthorUuid: reaction.get('targetAuthorUuid'),
            targetTimestamp: reaction.get('targetTimestamp'),
          },
        });

        // Note: generatedMessage comes with an id, so we have to force this save
        await Promise.all([
          window.Signal.Data.saveMessage(generatedMessage.attributes, {
            ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
            forceSave: true,
          }),
          generatedMessage.hydrateStoryContext(storyMessage),
        ]);

        log.info('Reactions.onReaction adding reaction to story', {
          reactionMessageId: getMessageIdForLogging(
            generatedMessage.attributes
          ),
          storyId: getMessageIdForLogging(storyMessage),
          targetTimestamp: reaction.get('targetTimestamp'),
          timestamp: reaction.get('timestamp'),
        });

        const messageToAdd = window.MessageController.register(
          generatedMessage.id,
          generatedMessage
        );
        if (isDirectConversation(targetConversation.attributes)) {
          await targetConversation.addSingleMessage(messageToAdd);
          if (!targetConversation.get('active_at')) {
            targetConversation.set({
              active_at: messageToAdd.get('timestamp'),
            });
            window.Signal.Data.updateConversation(
              targetConversation.attributes
            );
          }
        }

        if (isFromSomeoneElse) {
          log.info(
            'handleReaction: notifying for story reaction to ' +
              `${getMessageIdForLogging(storyMessage)} from someone else`
          );
          if (await shouldReplyNotifyUser(messageToAdd, targetConversation)) {
            drop(targetConversation.notify(messageToAdd));
          }
        }
      }
    } else {
      // Reactions to all messages other than stories will update the target message
      const previousLength = (this.get('reactions') || []).length;

      if (isFromThisDevice) {
        log.info(
          `handleReaction: sending reaction to ${this.idForLogging()} ` +
            'from this device'
        );

        const reactions = reactionUtil.addOutgoingReaction(
          this.get('reactions') || [],
          newReaction
        );
        this.set({ reactions });
      } else {
        const oldReactions = this.get('reactions') || [];
        let reactions: Array<MessageReactionType>;
        const oldReaction = oldReactions.find(re =>
          isNewReactionReplacingPrevious(re, newReaction)
        );
        if (oldReaction) {
          this.clearNotifications(oldReaction);
        }

        if (reaction.get('remove')) {
          log.info(
            'handleReaction: removing reaction for message',
            this.idForLogging()
          );

          if (isFromSync) {
            reactions = oldReactions.filter(
              re =>
                !isNewReactionReplacingPrevious(re, newReaction) ||
                re.timestamp > reaction.get('timestamp')
            );
          } else {
            reactions = oldReactions.filter(
              re => !isNewReactionReplacingPrevious(re, newReaction)
            );
          }
          this.set({ reactions });

          await window.Signal.Data.removeReactionFromConversation({
            emoji: reaction.get('emoji'),
            fromId: reaction.get('fromId'),
            targetAuthorUuid: reaction.get('targetAuthorUuid'),
            targetTimestamp: reaction.get('targetTimestamp'),
          });
        } else {
          log.info(
            'handleReaction: adding reaction for message',
            this.idForLogging()
          );

          let reactionToAdd: MessageReactionType;
          if (isFromSync) {
            const ourReactions = [
              newReaction,
              ...oldReactions.filter(
                re => re.fromId === reaction.get('fromId')
              ),
            ];
            reactionToAdd = maxBy(ourReactions, 'timestamp') || newReaction;
          } else {
            reactionToAdd = newReaction;
          }

          reactions = oldReactions.filter(
            re => !isNewReactionReplacingPrevious(re, reaction.attributes)
          );
          reactions.push(reactionToAdd);
          this.set({ reactions });

          if (isOutgoing(this.attributes) && isFromSomeoneElse) {
            void conversation.notify(this, reaction);
          }

          await window.Signal.Data.addReaction({
            conversationId: this.get('conversationId'),
            emoji: reaction.get('emoji'),
            fromId: reaction.get('fromId'),
            messageId: this.id,
            messageReceivedAt: this.get('received_at'),
            targetAuthorUuid: reaction.get('targetAuthorUuid'),
            targetTimestamp: reaction.get('targetTimestamp'),
          });
        }
      }

      const currentLength = (this.get('reactions') || []).length;
      log.info(
        'handleReaction:',
        `Done processing reaction for message ${this.idForLogging()}.`,
        `Went from ${previousLength} to ${currentLength} reactions.`
      );
    }

    if (isFromThisDevice) {
      let jobData: ConversationQueueJobData;
      if (storyMessage) {
        strictAssert(
          newReaction.emoji !== undefined,
          'New story reaction must have an emoji'
        );

        const generatedMessage = reaction.get('storyReactionMessage');
        strictAssert(
          generatedMessage,
          'Story reactions must provide storyReactionmessage'
        );
        await Promise.all([
          await window.Signal.Data.saveMessage(generatedMessage.attributes, {
            ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
            forceSave: true,
          }),
          generatedMessage.hydrateStoryContext(this.attributes),
        ]);

        void conversation.addSingleMessage(
          window.MessageController.register(
            generatedMessage.id,
            generatedMessage
          )
        );

        jobData = {
          type: conversationQueueJobEnum.enum.NormalMessage,
          conversationId: conversation.id,
          messageId: generatedMessage.id,
          revision: conversation.get('revision'),
        };
      } else {
        jobData = {
          type: conversationQueueJobEnum.enum.Reaction,
          conversationId: conversation.id,
          messageId: this.id,
          revision: conversation.get('revision'),
        };
      }
      if (shouldPersist) {
        await conversationJobQueue.add(jobData, async jobToInsert => {
          log.info(
            `enqueueReactionForSend: saving message ${this.idForLogging()} and job ${
              jobToInsert.id
            }`
          );
          await window.Signal.Data.saveMessage(this.attributes, {
            jobToInsert,
            ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
          });
        });
      } else {
        await conversationJobQueue.add(jobData);
      }
    } else if (shouldPersist && !isStory(this.attributes)) {
      await window.Signal.Data.saveMessage(this.attributes, {
        ourUuid: window.textsecure.storage.user.getCheckedUuid().toString(),
      });
    }
  }

  async handleDeleteForEveryone(
    del: DeleteModel,
    shouldPersist = true
  ): Promise<void> {
    if (this.deletingForEveryone || this.get('deletedForEveryone')) {
      return;
    }

    log.info('Handling DOE.', {
      messageId: this.id,
      fromId: del.get('fromId'),
      targetSentTimestamp: del.get('targetSentTimestamp'),
      messageServerTimestamp: this.get('serverTimestamp'),
      deleteServerTimestamp: del.get('serverTimestamp'),
    });

    try {
      this.deletingForEveryone = true;

      // Remove any notifications for this message
      notificationService.removeBy({ messageId: this.get('id') });

      // Erase the contents of this message
      await this.eraseContents(
        { deletedForEveryone: true, reactions: [] },
        shouldPersist
      );

      // Update the conversation's last message in case this was the last message
      void this.getConversation()?.updateLastMessage();
    } finally {
      this.deletingForEveryone = undefined;
    }
  }

  clearNotifications(reaction: Partial<ReactionType> = {}): void {
    notificationService.removeBy({
      ...reaction,
      messageId: this.id,
    });
  }
}

window.Whisper.Message = MessageModel;

window.Whisper.MessageCollection = window.Backbone.Collection.extend({
  model: window.Whisper.Message,
  comparator(left: Readonly<MessageModel>, right: Readonly<MessageModel>) {
    if (left.get('received_at') === right.get('received_at')) {
      return (left.get('sent_at') || 0) - (right.get('sent_at') || 0);
    }

    return (left.get('received_at') || 0) - (right.get('received_at') || 0);
  },
});
