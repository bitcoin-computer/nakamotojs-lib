import * as assert from 'assert';
import BIP32Factory from 'bip32';
import ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { describe, it } from 'mocha';
import { PsbtInput, TapLeafScript } from 'bip174/src/lib/interfaces';
import * as bitcoin from '../..';
import { Taptree } from '../../src/types';
import { regtestUtils, regtestLitecoinUtils } from './_regtest';
import { witnessStackToScriptWitness } from '../../src/psbt/psbtutils';
import { TapLeaf } from 'bip174/src/lib/interfaces';
const { toXOnly, tapTreeToList, tapTreeFromList } = bitcoin.bip371;

const rng = require('randombytes');
bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);
let regtest = regtestUtils.network;

before(async () => {
  regtest =
    (await regtestUtils.chain()) === 'LTC'
      ? regtestLitecoinUtils.network
      : regtestUtils.network;
});

describe('nakamotojs-lib (transaction with taproot)', () => {
  it('can create (and broadcast via 3PBP) a taproot key-path spend Transaction', async () => {
    const internalKey = bip32.fromSeed(rng(64), regtest);
    const p2pkhKey = bip32.fromSeed(rng(64), regtest);

    const { output } = bitcoin.payments.p2tr({
      internalPubkey: toXOnly(internalKey.publicKey),
      network: regtest,
    });

    const { output: p2pkhOutput } = bitcoin.payments.p2pkh({
      pubkey: p2pkhKey.publicKey,
      network: regtest,
    });

    // amount from faucet
    const amount = 42e4;
    // amount to send
    const sendAmount = amount - 1e4;
    // get faucet
    const unspent = await regtestUtils.faucetComplex(output!, amount);

    // non segwit utxo
    const p2pkhUnspent = await regtestUtils.faucetComplex(p2pkhOutput!, amount);
    const utx = await regtestUtils.fetch(p2pkhUnspent.txId);
    const nonWitnessUtxo = Buffer.from(utx.txHex, 'hex');

    const psbt = new bitcoin.Psbt({ network: regtest });
    psbt.addInput({
      hash: unspent.txId,
      index: 0,
      witnessUtxo: { value: amount, script: output! },
      tapInternalKey: toXOnly(internalKey.publicKey),
    });
    psbt.addInput({ index: 0, hash: p2pkhUnspent.txId, nonWitnessUtxo });

    const sendInternalKey = bip32.fromSeed(rng(64), regtest);
    const sendPubKey = toXOnly(sendInternalKey.publicKey);
    const { address: sendAddress } = bitcoin.payments.p2tr({
      internalPubkey: sendPubKey,
      network: regtest,
    });

    psbt.addOutput({
      value: sendAmount,
      address: sendAddress!,
      tapInternalKey: sendPubKey,
    });

    const tweakedSigner = tweakSigner(internalKey!, { network: regtest });
    await psbt.signInputAsync(0, tweakedSigner);
    await psbt.signInputAsync(1, p2pkhKey);

    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const rawTx = tx.toBuffer();

    const hex = rawTx.toString('hex');

    await regtestUtils.broadcast(hex);
    await regtestUtils.verify({
      txId: tx.getId(),
      address: sendAddress!,
      vout: 0,
      value: sendAmount,
    });
  });

  it('can create (and broadcast via 3PBP) a taproot key-path spend Transaction (with unused scriptTree)', async () => {
    const internalKey = bip32.fromSeed(rng(64), regtest);
    const leafKey = bip32.fromSeed(rng(64), regtest);

    const leafScriptAsm = `${toXOnly(leafKey.publicKey).toString(
      'hex',
    )} OP_CHECKSIG`;
    const leafScript = bitcoin.script.fromASM(leafScriptAsm);

    const scriptTree = {
      output: leafScript,
    };

    const { output, address, hash } = bitcoin.payments.p2tr({
      internalPubkey: toXOnly(internalKey.publicKey),
      scriptTree,
      network: regtest,
    });

    // amount from faucet
    const amount = 42e4;
    // amount to send
    const sendAmount = amount - 1e4;
    // get faucet
    const unspent = await regtestUtils.faucetComplex(output!, amount);

    const psbt = new bitcoin.Psbt({ network: regtest });
    psbt.addInput({
      hash: unspent.txId,
      index: 0,
      witnessUtxo: { value: amount, script: output! },
      tapInternalKey: toXOnly(internalKey.publicKey),
      tapMerkleRoot: hash,
    });
    psbt.addOutput({ value: sendAmount, address: address! });

    const tweakedSigner = tweakSigner(internalKey!, {
      tweakHash: hash,
      network: regtest,
    });
    psbt.signInput(0, tweakedSigner);

    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const rawTx = tx.toBuffer();

    const hex = rawTx.toString('hex');

    await regtestUtils.broadcast(hex);
    await regtestUtils.verify({
      txId: tx.getId(),
      address: address!,
      vout: 0,
      value: sendAmount,
    });
  });

  it('can create (and broadcast via 3PBP) a taproot script-path spend Transaction - OP_CHECKSIG', async () => {
    const internalKey = bip32.fromSeed(rng(64), regtest);
    const leafKey = bip32.fromSeed(rng(64), regtest);

    const leafScriptAsm = `${toXOnly(leafKey.publicKey).toString(
      'hex',
    )} OP_CHECKSIG`;
    const leafScript = bitcoin.script.fromASM(leafScriptAsm);

    const scriptTree: Taptree = [
      [
        {
          output: bitcoin.script.fromASM(
            '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0 OP_CHECKSIG',
          ),
        },
        [
          {
            output: bitcoin.script.fromASM(
              '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac1 OP_CHECKSIG',
            ),
          },
          {
            output: bitcoin.script.fromASM(
              '2258b1c3160be0864a541854eec9164a572f094f7562628281a8073bb89173a7 OP_CHECKSIG',
            ),
          },
        ],
      ],
      [
        {
          output: bitcoin.script.fromASM(
            '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac2 OP_CHECKSIG',
          ),
        },
        [
          {
            output: bitcoin.script.fromASM(
              '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac3 OP_CHECKSIG',
            ),
          },
          [
            {
              output: bitcoin.script.fromASM(
                '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac4 OP_CHECKSIG',
              ),
            },
            {
              output: leafScript,
            },
          ],
        ],
      ],
    ];
    const redeem = {
      output: leafScript,
      redeemVersion: 192,
    };

    const { output, witness } = bitcoin.payments.p2tr({
      internalPubkey: toXOnly(internalKey.publicKey),
      scriptTree,
      redeem,
      network: regtest,
    });

    // amount from faucet
    const amount = 42e4;
    // amount to send
    const sendAmount = amount - 1e4;
    // get faucet
    const unspent = await regtestUtils.faucetComplex(output!, amount);

    const psbt = new bitcoin.Psbt({ network: regtest });
    psbt.addInput({
      hash: unspent.txId,
      index: 0,
      witnessUtxo: { value: amount, script: output! },
    });
    psbt.updateInput(0, {
      tapLeafScript: [
        {
          leafVersion: redeem.redeemVersion,
          script: redeem.output,
          controlBlock: witness![witness!.length - 1],
        },
      ],
    });

    const sendInternalKey = bip32.fromSeed(rng(64), regtest);
    const sendPubKey = toXOnly(sendInternalKey.publicKey);
    const { address: sendAddress } = bitcoin.payments.p2tr({
      internalPubkey: sendPubKey,
      scriptTree,
      network: regtest,
    });

    psbt.addOutput({
      value: sendAmount,
      address: sendAddress!,
      tapInternalKey: sendPubKey,
      tapTree: { leaves: tapTreeToList(scriptTree) },
    });

    psbt.signInput(0, leafKey);
    psbt.finalizeInput(0);
    const tx = psbt.extractTransaction();
    const rawTx = tx.toBuffer();
    const hex = rawTx.toString('hex');

    await regtestUtils.broadcast(hex);
    await regtestUtils.verify({
      txId: tx.getId(),
      address: sendAddress!,
      vout: 0,
      value: sendAmount,
    });
  });

  it('can create (and broadcast via 3PBP) a taproot script-path spend Transaction - OP_CHECKSEQUENCEVERIFY', async () => {
    const internalKey = bip32.fromSeed(rng(64), regtest);
    const leafKey = bip32.fromSeed(rng(64), regtest);
    const leafPubkey = toXOnly(leafKey.publicKey).toString('hex');

    const leafScriptAsm = `OP_10 OP_CHECKSEQUENCEVERIFY OP_DROP ${leafPubkey} OP_CHECKSIG`;
    const leafScript = bitcoin.script.fromASM(leafScriptAsm);

    const scriptTree: Taptree = [
      {
        output: bitcoin.script.fromASM(
          '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0 OP_CHECKSIG',
        ),
      },
      [
        {
          output: bitcoin.script.fromASM(
            '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0 OP_CHECKSIG',
          ),
        },
        {
          output: leafScript,
        },
      ],
    ];
    const redeem = {
      output: leafScript,
      redeemVersion: 192,
    };

    const { output, witness } = bitcoin.payments.p2tr({
      internalPubkey: toXOnly(internalKey.publicKey),
      scriptTree,
      redeem,
      network: regtest,
    });

    // amount from faucet
    const amount = 42e4;
    // amount to send
    const sendAmount = amount - 1e4;
    // get faucet
    const unspent = await regtestUtils.faucetComplex(output!, amount);

    const psbt = new bitcoin.Psbt({ network: regtest });
    psbt.addInput({
      hash: unspent.txId,
      index: 0,
      sequence: 10,
      witnessUtxo: { value: amount, script: output! },
    });
    psbt.updateInput(0, {
      tapLeafScript: [
        {
          leafVersion: redeem.redeemVersion,
          script: redeem.output,
          controlBlock: witness![witness!.length - 1],
        },
      ],
    });

    const sendInternalKey = bip32.fromSeed(rng(64), regtest);
    const sendPubKey = toXOnly(sendInternalKey.publicKey);
    const { address: sendAddress } = bitcoin.payments.p2tr({
      internalPubkey: sendPubKey,
      scriptTree,
      network: regtest,
    });

    psbt.addOutput({ value: sendAmount, address: sendAddress! });
    // just to test that updateOutput works as expected
    psbt.updateOutput(0, {
      tapInternalKey: sendPubKey,
      tapTree: { leaves: tapTreeToList(scriptTree) },
    });

    await psbt.signInputAsync(0, leafKey);

    psbt.finalizeInput(0);
    const tx = psbt.extractTransaction();
    const rawTx = tx.toBuffer();
    const hex = rawTx.toString('hex');

    try {
      // broadcast before the confirmation period has expired
      await regtestUtils.broadcast(hex);
      throw new Error('Broadcast should fail.');
    } catch (err) {
      if ((err as any).message !== 'non-BIP68-final')
        throw new Error(
          'Expected OP_CHECKSEQUENCEVERIFY validation to fail. But it faild with: ' +
            err,
        );
    }
    await regtestUtils.mine(10);
    await regtestUtils.broadcast(hex);
    await regtestUtils.verify({
      txId: tx.getId(),
      address: sendAddress!,
      vout: 0,
      value: sendAmount,
    });
  });

  it('can create (and broadcast via 3PBP) a taproot script-path spend Transaction - OP_CHECKSIGADD (3-of-3)', async () => {
    const internalKey = bip32.fromSeed(rng(64), regtest);

    const leafKeys = [];
    const leafPubkeys = [];
    for (let i = 0; i < 3; i++) {
      const leafKey = bip32.fromSeed(rng(64), regtest);
      leafKeys.push(leafKey);
      leafPubkeys.push(toXOnly(leafKey.publicKey).toString('hex'));
    }

    const leafScriptAsm = `${leafPubkeys[2]} OP_CHECKSIG ${leafPubkeys[1]} OP_CHECKSIGADD ${leafPubkeys[0]} OP_CHECKSIGADD OP_3 OP_NUMEQUAL`;

    const leafScript = bitcoin.script.fromASM(leafScriptAsm);

    const scriptTree: Taptree = [
      {
        output: bitcoin.script.fromASM(
          '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0 OP_CHECKSIG',
        ),
      },
      [
        {
          output: bitcoin.script.fromASM(
            '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0 OP_CHECKSIG',
          ),
        },
        {
          output: leafScript,
        },
      ],
    ];
    const redeem = {
      output: leafScript,
      redeemVersion: 192,
    };

    const { output, address, witness } = bitcoin.payments.p2tr({
      internalPubkey: toXOnly(internalKey.publicKey),
      scriptTree,
      redeem,
      network: regtest,
    });

    // amount from faucet
    const amount = 42e4;
    // amount to send
    const sendAmount = amount - 1e4;
    // get faucet
    const unspent = await regtestUtils.faucetComplex(output!, amount);

    const psbt = new bitcoin.Psbt({ network: regtest });
    psbt.addInput({
      hash: unspent.txId,
      index: 0,
      witnessUtxo: { value: amount, script: output! },
    });
    psbt.updateInput(0, {
      tapLeafScript: [
        {
          leafVersion: redeem.redeemVersion,
          script: redeem.output,
          controlBlock: witness![witness!.length - 1],
        },
      ],
    });

    psbt.addOutput({ value: sendAmount, address: address! });

    // random order for signers
    psbt.signInput(0, leafKeys[1]);
    psbt.signInput(0, leafKeys[2]);
    psbt.signInput(0, leafKeys[0]);

    psbt.finalizeInput(0);
    const tx = psbt.extractTransaction();
    const rawTx = tx.toBuffer();
    const hex = rawTx.toString('hex');

    await regtestUtils.broadcast(hex);
    await regtestUtils.verify({
      txId: tx.getId(),
      address: address!,
      vout: 0,
      value: sendAmount,
    });
  });

  it('can create (and broadcast via 3PBP) a taproot script-path spend Transaction - custom finalizer', async () => {
    const leafCount = 8;
    const leaves = Array.from({ length: leafCount }).map(
      (_, index) =>
        ({
          depth: 3,
          leafVersion: 192,
          script: bitcoin.script.fromASM(`OP_ADD OP_${index * 2} OP_EQUAL`),
        } as TapLeaf),
    );
    const scriptTree = tapTreeFromList(leaves);

    for (let leafIndex = 1; leafIndex < leafCount; leafIndex++) {
      const redeem = {
        output: bitcoin.script.fromASM(`OP_ADD OP_${leafIndex * 2} OP_EQUAL`),
        redeemVersion: 192,
      };

      const internalKey = bip32.fromSeed(rng(64), regtest);
      const { output, witness } = bitcoin.payments.p2tr({
        internalPubkey: toXOnly(internalKey.publicKey),
        scriptTree,
        redeem,
        network: regtest,
      });

      // amount from faucet
      const amount = 42e4;
      // amount to send
      const sendAmount = amount - 1e4;
      // get faucet
      const unspent = await regtestUtils.faucetComplex(output!, amount);

      const psbt = new bitcoin.Psbt({ network: regtest });
      psbt.addInput({
        hash: unspent.txId,
        index: 0,
        witnessUtxo: { value: amount, script: output! },
      });

      const tapLeafScript: TapLeafScript = {
        leafVersion: redeem.redeemVersion,
        script: redeem.output,
        controlBlock: witness![witness!.length - 1],
      };
      psbt.updateInput(0, { tapLeafScript: [tapLeafScript] });

      const sendInternalKey = bip32.fromSeed(rng(64), regtest);
      const sendPubKey = toXOnly(sendInternalKey.publicKey);
      const { address: sendAddress } = bitcoin.payments.p2tr({
        internalPubkey: sendPubKey,
        scriptTree,
        network: regtest,
      });
      assert(sendAddress, 'address should be defined');
      psbt.addOutput({
        value: sendAmount,
        address: sendAddress!,
      });

      const leafIndexFinalizerFn = buildLeafIndexFinalizer(
        tapLeafScript,
        leafIndex,
      );
      psbt.finalizeInput(0, leafIndexFinalizerFn);
      const tx = psbt.extractTransaction();
      const rawTx = tx.toBuffer();
      const hex = rawTx.toString('hex');

      await regtestUtils.broadcast(hex);
      await regtestUtils.verify({
        txId: tx.getId(),
        address: sendAddress!,
        vout: 0,
        value: sendAmount,
      });
    }
  });
});

function buildLeafIndexFinalizer(
  tapLeafScript: TapLeafScript,
  leafIndex: number,
): (
  inputIndex: number,
  _input: PsbtInput,
  _tapLeafHashToFinalize?: Buffer,
) => {
  finalScriptWitness: Buffer | undefined;
} {
  return (
    inputIndex: number,
    _input: PsbtInput,
    _tapLeafHashToFinalize?: Buffer,
  ): {
    finalScriptWitness: Buffer | undefined;
  } => {
    try {
      const scriptSolution = [
        Buffer.from([leafIndex]),
        Buffer.from([leafIndex]),
      ];
      const witness = scriptSolution
        .concat(tapLeafScript.script)
        .concat(tapLeafScript.controlBlock);
      return { finalScriptWitness: witnessStackToScriptWitness(witness) };
    } catch (err) {
      throw new Error(`Can not finalize taproot input #${inputIndex}: ${err}`);
    }
  };
}

// This logic will be extracted to ecpair
function tweakSigner(signer: bitcoin.Signer, opts: any = {}): bitcoin.Signer {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let privateKey: Uint8Array | undefined = signer.privateKey!;
  if (!privateKey) {
    throw new Error('Private key is required for tweaking signer!');
  }
  if (signer.publicKey[0] === 3) {
    privateKey = ecc.privateNegate(privateKey);
  }

  const tweakedPrivateKey = ecc.privateAdd(
    privateKey,
    tapTweakHash(toXOnly(signer.publicKey), opts.tweakHash),
  );
  if (!tweakedPrivateKey) {
    throw new Error('Invalid tweaked private key!');
  }

  return ECPair.fromPrivateKey(Buffer.from(tweakedPrivateKey), {
    network: opts.network,
  });
}

function tapTweakHash(pubKey: Buffer, h: Buffer | undefined): Buffer {
  return bitcoin.crypto.taggedHash(
    'TapTweak',
    Buffer.concat(h ? [pubKey, h] : [pubKey]),
  );
}
