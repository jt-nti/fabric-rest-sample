/*
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Request, Response } from 'express';
import { Contract } from 'fabric-network';
import { protos } from 'fabric-protos';
import { getReasonPhrase, StatusCodes } from 'http-status-codes';
import { Redis } from 'ioredis';
import { evatuateTransaction } from './fabric';
import { logger } from './logger';
import * as config from './config';
import { TransactionNotFoundError } from './errors';

const { INTERNAL_SERVER_ERROR, NOT_FOUND, OK } = StatusCodes;

export const transactionsRouter = express.Router();

type Progress = 'ACCEPTED' | 'RETRYING' | 'DONE';

transactionsRouter.get(
  '/:transactionId',
  async (req: Request, res: Response) => {
    const transactionId = req.params.transactionId;
    logger.debug('Read request received for transaction ID %s', transactionId);

    let foundTransaction = false;
    let progress: Progress = 'DONE';
    let validationCode = '';

    const qscc: Contract = req.app.get('contracts').qscc;
    const redis: Redis = req.app.get('redis');

    try {
      const savedTransaction = await (redis as Redis).hgetall(
        `txn:${transactionId}`
      );
      logger.debug(
        { transactionId: transactionId, state: savedTransaction },
        'Saved transaction state'
      );

      if (savedTransaction.state) {
        foundTransaction = true;
        const retries = parseInt(savedTransaction.retries);
        if (retries > 0) {
          progress = 'RETRYING';
        } else {
          progress = 'ACCEPTED';
        }
      }
    } catch (err) {
      logger.error(
        err,
        'Redis error processing read request for transaction ID %s',
        transactionId
      );

      return res.status(INTERNAL_SERVER_ERROR).json({
        status: getReasonPhrase(INTERNAL_SERVER_ERROR),
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const data = await evatuateTransaction(
        qscc,
        'GetTransactionByID',
        config.channelName,
        transactionId
      );

      foundTransaction = true;
      // TODO is it possible to use the BlockDecoder decodeTransaction
      // function in fabric-common?
      const processedTransaction = protos.ProcessedTransaction.decode(data);
      validationCode =
        protos.TxValidationCode[processedTransaction.validationCode];
    } catch (err) {
      if (!(err instanceof TransactionNotFoundError)) {
        logger.error(
          err,
          'Fabric error processing read request for transaction ID %s',
          transactionId
        );

        return res.status(INTERNAL_SERVER_ERROR).json({
          status: getReasonPhrase(INTERNAL_SERVER_ERROR),
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (foundTransaction) {
      return res.status(OK).json({
        status: getReasonPhrase(OK),
        progress: progress,
        validationCode: validationCode,
        timestamp: new Date().toISOString(),
      });
    } else {
      return res.status(NOT_FOUND).json({
        status: getReasonPhrase(NOT_FOUND),
        timestamp: new Date().toISOString(),
      });
    }
  }
);